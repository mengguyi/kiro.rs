//! Anthropic API 中间件

use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Json, Response},
};

use crate::common::auth;
use crate::kiro::provider::KiroProvider;

use super::types::ErrorResponse;

/// 凭证 ID 标记（auth_middleware 解析后塞进 request extensions，handler 取出）
#[derive(Clone, Copy, Debug)]
pub struct CredentialId(pub u64);

/// 负载均衡模式常量（与 token_manager 共识）
const MODE_PER_CREDENTIAL: &str = "per_credential";

/// 应用共享状态
#[derive(Clone)]
pub struct AppState {
    /// API 密钥
    pub api_key: String,
    /// Kiro Provider（可选，用于实际 API 调用）
    /// 内部使用 MultiTokenManager，已支持线程安全的多凭据管理
    pub kiro_provider: Option<Arc<KiroProvider>>,
    /// 是否开启非流式响应的 thinking 块提取
    pub extract_thinking: bool,
    /// builtin 工具策略（web_fetch agentic 用，从 Config 派生）
    pub builtin_policy: crate::builtin_tools::BuiltinPolicy,
}

impl AppState {
    /// 创建新的应用状态
    pub fn new(api_key: impl Into<String>, extract_thinking: bool) -> Self {
        Self {
            api_key: api_key.into(),
            kiro_provider: None,
            extract_thinking,
            builtin_policy: crate::builtin_tools::BuiltinPolicy::default(),
        }
    }

    /// 设置 KiroProvider
    pub fn with_kiro_provider(mut self, provider: KiroProvider) -> Self {
        self.kiro_provider = Some(Arc::new(provider));
        self
    }

    /// 设置 builtin 策略（从 Config 派生）
    pub fn with_builtin_policy(mut self, policy: crate::builtin_tools::BuiltinPolicy) -> Self {
        self.builtin_policy = policy;
        self
    }
}

/// API Key 认证中间件
///
/// 支持三种 key 形态：
/// - `{base_key}`：走系统配置的负载策略（priority / balanced）。
///   在 `per_credential` 模式下**拒绝**（401），强制所有请求由外部调度（new-api）指定 cred ID。
/// - `{base_key}-{cred_id}`：锁定凭证，写入 [`CredentialId`] 到 request extensions。
/// - 其他：401。
pub async fn auth_middleware(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Some(key) = auth::extract_api_key(&request) else {
        return unauthorized();
    };

    // 1. 裸 base_key：根据模式决定放行还是拒绝
    if auth::constant_time_eq(&key, &state.api_key) {
        let mode = state
            .kiro_provider
            .as_ref()
            .map(|p| p.load_balancing_mode())
            .unwrap_or_default();
        if mode == MODE_PER_CREDENTIAL {
            tracing::warn!("per_credential 模式拒绝裸 base_key，请使用 {{base}}-{{id}} 后缀");
            return unauthorized();
        }
        return next.run(request).await;
    }

    // 2. {base_key}-{cred_id} 后缀
    if let Some(cred_id) = auth::parse_credential_id(&key, &state.api_key) {
        tracing::debug!("API key 指定凭证 #{}", cred_id);
        request.extensions_mut().insert(CredentialId(cred_id));
        return next.run(request).await;
    }

    // 3. 都不匹配
    unauthorized()
}

fn unauthorized() -> Response {
    let error = ErrorResponse::authentication_error();
    (StatusCode::UNAUTHORIZED, Json(error)).into_response()
}

/// CORS 中间件层
///
/// **安全说明**：当前配置允许所有来源（Any），这是为了支持公开 API 服务。
/// 如果需要更严格的安全控制，请根据实际需求配置具体的允许来源、方法和头信息。
///
/// # 配置说明
/// - `allow_origin(Any)`: 允许任何来源的请求
/// - `allow_methods(Any)`: 允许任何 HTTP 方法
/// - `allow_headers(Any)`: 允许任何请求头
pub fn cors_layer() -> tower_http::cors::CorsLayer {
    use tower_http::cors::{Any, CorsLayer};

    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}
