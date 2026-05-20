//! 公共认证工具函数

use axum::{
    body::Body,
    http::{Request, header},
};
use subtle::ConstantTimeEq;

/// 从请求中提取 API Key
///
/// 支持两种认证方式：
/// - `x-api-key` header
/// - `Authorization: Bearer <token>` header
pub fn extract_api_key(request: &Request<Body>) -> Option<String> {
    // 优先检查 x-api-key
    if let Some(key) = request
        .headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
    {
        return Some(key.to_string());
    }

    // 其次检查 Authorization: Bearer
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

/// 常量时间字符串比较，防止时序攻击
///
/// 无论字符串内容如何，比较所需的时间都是恒定的，
/// 这可以防止攻击者通过测量响应时间来猜测 API Key。
///
/// 使用经过安全审计的 `subtle` crate 实现
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// 解析 API Key，提取凭证 ID（如果有）
///
/// 调用约定：
/// - `api_key` 完全等于 `base_api_key` → `None`（走系统配置的负载策略）
/// - `api_key == {base_api_key}-{digits}` → `Some(digits.parse::<u64>())`
/// - 其他 → `None`（外层据此决定是否 401）
///
/// 注意：本函数只解析，不做认证。
/// 外层应该先确认 `api_key.starts_with(base_api_key)`，并按业务策略
/// 处理"裸 base_key"和"未知 key"两种情况。
///
/// 借鉴自 hank9999/kiro.rs PR #136。
pub fn parse_credential_id(api_key: &str, base_api_key: &str) -> Option<u64> {
    if api_key == base_api_key {
        return None;
    }
    let prefix = format!("{}-", base_api_key);
    api_key
        .strip_prefix(&prefix)
        .and_then(|suffix| suffix.parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "sk-ant-1234567890";

    #[test]
    fn exact_match_returns_none() {
        assert_eq!(parse_credential_id(BASE, BASE), None);
    }

    #[test]
    fn suffix_id_parsed() {
        assert_eq!(parse_credential_id("sk-ant-1234567890-5", BASE), Some(5));
    }

    #[test]
    fn suffix_large_id() {
        assert_eq!(
            parse_credential_id("sk-ant-1234567890-9999999999", BASE),
            Some(9999999999)
        );
    }

    #[test]
    fn suffix_zero_ok() {
        assert_eq!(parse_credential_id("sk-ant-1234567890-0", BASE), Some(0));
    }

    #[test]
    fn non_numeric_suffix_none() {
        assert_eq!(parse_credential_id("sk-ant-1234567890-abc", BASE), None);
    }

    #[test]
    fn empty_suffix_none() {
        assert_eq!(parse_credential_id("sk-ant-1234567890-", BASE), None);
    }

    #[test]
    fn wrong_prefix_none() {
        assert_eq!(parse_credential_id("sk-wrong-key-5", BASE), None);
    }

    #[test]
    fn partial_match_none() {
        assert_eq!(parse_credential_id("sk-ant-123", BASE), None);
    }

    #[test]
    fn negative_suffix_none() {
        assert_eq!(parse_credential_id("sk-ant-1234567890--1", BASE), None);
    }

    #[test]
    fn trailing_garbage_none() {
        assert_eq!(parse_credential_id("sk-ant-1234567890-5-extra", BASE), None);
    }
}
