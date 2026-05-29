//! 内建工具（builtin tools）
//!
//! Anthropic 协议层 "server-side tool"（如 `web_fetch_20260209` / `web_search_20250305`）
//! 在 AWS Q 上游没有实现，kiro.rs 在反代过程中**本地补齐**：
//!
//! 1. converter 把 server tool 声明转成 client function tool（注入 AWS Q）
//! 2. stream 拦截到该 function tool 的 `tool_use` 时 → kiro.rs 进程内执行
//! 3. 把结果以 Anthropic `*_tool_result` 块的格式合成回 SSE 流
//!
//! 当前只支持 `web_fetch`，将来可扩展 `web_search`（本地版本，对比 AWS Q 上游版本）/
//! `code_execution` 等。

pub mod web_fetch;

use serde::{Deserialize, Serialize};

/// 内建工具种类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinKind {
    /// `web_fetch_2025xxxx` / `web_fetch_2026xxxx`
    WebFetch,
}

impl BuiltinKind {
    /// 从 Anthropic 协议 `tools[].type` 字段识别 builtin 种类
    ///
    /// 返回 `Some(BuiltinKind)` 表示是已知 builtin，应被拦截；
    /// `None` 表示原样透传给 AWS Q。
    pub fn from_tool_type(tool_type: &str) -> Option<Self> {
        if tool_type.starts_with("web_fetch_") {
            Some(Self::WebFetch)
        } else {
            None
        }
    }

    /// builtin 在 Anthropic 客户端视角的 tool 名（用于 `server_tool_use.name`）
    pub fn anthropic_tool_name(&self) -> &'static str {
        match self {
            Self::WebFetch => "web_fetch",
        }
    }

    /// builtin 在 Anthropic `message_delta.usage.server_tool_use` 计数字段名
    pub fn usage_counter_key(&self) -> &'static str {
        match self {
            Self::WebFetch => "web_fetch_requests",
        }
    }
}

/// 客户端在 tool 声明里给的元数据（per-request）
///
/// 由 [`crate::anthropic::converter::convert_tools`] 在协议转换时填充，
/// 由 stream 层的 agentic loop 读取并应用。
#[derive(Debug, Clone)]
#[allow(dead_code)] // anthropic_type / citations_enabled 保留供日志/未来扩展使用
pub struct BuiltinToolMeta {
    pub kind: BuiltinKind,
    /// Anthropic 协议层的 tool type 全名（如 `"web_fetch_20260209"`），保留用于日志
    pub anthropic_type: String,
    /// 客户端给的最大调用次数；None 表示客户端没给，应用默认
    pub max_uses: Option<u32>,
    /// 客户端给的允许域名（精确匹配 host，含子域）；None / 空 表示不限
    pub allowed_domains: Option<Vec<String>>,
    /// 客户端给的禁止域名；与 `allowed_domains` 并存时，blocked 优先
    pub blocked_domains: Option<Vec<String>>,
    /// 客户端给的内容 token 上限；None 表示用 [`BuiltinPolicy::default_max_content_tokens`]
    pub max_content_tokens: Option<u32>,
    /// 客户端是否要求引用追踪（暂未实现，保留用于将来字段）
    pub citations_enabled: bool,
}

/// 管理员级（kiro.rs 进程全局）策略，对应 `Config` 里的 `webFetchXxx` 字段
///
/// 这层是 SSRF 与 abuse 保护的硬底线，**不被客户端 tool 声明覆盖**。
#[derive(Debug, Clone)]
pub struct BuiltinPolicy {
    /// `web_fetch` 在单次对话内的硬上限调用次数（防 agentic loop 失控）
    /// 客户端 `max_uses` 即使大于此值也会被截断
    pub web_fetch_max_uses_hard_limit: u32,
    /// 永远禁止抓取的域名（管理员维护，客户端 `allowed_domains` 也不能覆盖）
    pub web_fetch_blocked_domains: Vec<String>,
    /// 是否禁止抓取私有/loopback/link-local 网段（默认 true，强烈不建议关）
    pub web_fetch_block_private_networks: bool,
    /// 客户端没给 `max_uses` 时的默认值
    pub web_fetch_default_max_uses: u32,
    /// 客户端没给 `max_content_tokens` 时的默认值
    pub web_fetch_default_max_content_tokens: u32,
    /// 单次 HTTP 响应体硬上限（字节，超出截断 + 标 truncated）
    pub web_fetch_response_size_limit_bytes: usize,
    /// 单次 HTTP 总超时（秒）
    pub web_fetch_request_timeout_secs: u64,
}

impl Default for BuiltinPolicy {
    fn default() -> Self {
        Self {
            web_fetch_max_uses_hard_limit: 20,
            web_fetch_blocked_domains: Vec::new(),
            web_fetch_block_private_networks: true,
            web_fetch_default_max_uses: 5,
            web_fetch_default_max_content_tokens: 50_000,
            web_fetch_response_size_limit_bytes: 10 * 1024 * 1024,
            web_fetch_request_timeout_secs: 30,
        }
    }
}

impl BuiltinPolicy {
    /// 合并客户端 meta 和管理员 policy，得到实际生效的限制
    pub fn effective_max_uses(&self, client: &BuiltinToolMeta) -> u32 {
        let requested = client.max_uses.unwrap_or(self.web_fetch_default_max_uses);
        requested.min(self.web_fetch_max_uses_hard_limit)
    }

    pub fn effective_max_content_tokens(&self, client: &BuiltinToolMeta) -> u32 {
        client
            .max_content_tokens
            .unwrap_or(self.web_fetch_default_max_content_tokens)
    }
}

impl From<&crate::model::config::Config> for BuiltinPolicy {
    fn from(cfg: &crate::model::config::Config) -> Self {
        Self {
            web_fetch_max_uses_hard_limit: cfg.web_fetch_max_uses_hard_limit,
            web_fetch_blocked_domains: cfg.web_fetch_blocked_domains.clone(),
            web_fetch_block_private_networks: cfg.web_fetch_block_private_networks,
            web_fetch_default_max_uses: cfg.web_fetch_default_max_uses,
            web_fetch_default_max_content_tokens: cfg.web_fetch_default_max_content_tokens,
            web_fetch_response_size_limit_bytes: cfg.web_fetch_response_size_limit_bytes,
            web_fetch_request_timeout_secs: cfg.web_fetch_request_timeout_secs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_tool_type_recognizes_web_fetch_variants() {
        assert_eq!(
            BuiltinKind::from_tool_type("web_fetch_20260209"),
            Some(BuiltinKind::WebFetch)
        );
        assert_eq!(
            BuiltinKind::from_tool_type("web_fetch_20250910"),
            Some(BuiltinKind::WebFetch)
        );
        assert_eq!(BuiltinKind::from_tool_type("web_search_20250305"), None);
        assert_eq!(BuiltinKind::from_tool_type("custom_tool"), None);
    }

    #[test]
    fn policy_caps_client_max_uses() {
        let policy = BuiltinPolicy {
            web_fetch_max_uses_hard_limit: 5,
            ..Default::default()
        };
        let meta = BuiltinToolMeta {
            kind: BuiltinKind::WebFetch,
            anthropic_type: "web_fetch_20260209".to_string(),
            max_uses: Some(100),
            allowed_domains: None,
            blocked_domains: None,
            max_content_tokens: None,
            citations_enabled: false,
        };
        assert_eq!(policy.effective_max_uses(&meta), 5);
    }

    #[test]
    fn policy_default_when_client_omits_max_uses() {
        let policy = BuiltinPolicy {
            web_fetch_default_max_uses: 5,
            web_fetch_max_uses_hard_limit: 20,
            ..Default::default()
        };
        let meta = BuiltinToolMeta {
            kind: BuiltinKind::WebFetch,
            anthropic_type: "web_fetch_20260209".to_string(),
            max_uses: None,
            allowed_domains: None,
            blocked_domains: None,
            max_content_tokens: None,
            citations_enabled: false,
        };
        assert_eq!(policy.effective_max_uses(&meta), 5);
    }
}
