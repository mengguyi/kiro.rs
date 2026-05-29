//! `web_fetch` builtin 实现
//!
//! 协议：客户端在 `tools` 列表里声明 `web_fetch_2025xx` / `web_fetch_2026xx` server tool，
//! converter 把它转成 client function tool 注入 AWS Q；
//! 模型回应 `tool_use(web_fetch_internal_xxx, {url})` → stream 层拦截 → 调本模块 [`fetch_url`]。
//!
//! 行为对齐 Anthropic web_fetch_20260209（allowed_callers=direct 模式下）：
//! - 成功：返回 markdown + title + retrieved_at
//! - 失败：返回 [`FetchError`]，对应 Anthropic 的 `web_fetch_tool_result_error.error_code`
//!
//! SSRF 防护是**管理员级硬底线**，[`BuiltinPolicy::web_fetch_block_private_networks`] 默认 true，
//! 不被客户端 tool 声明的 `allowed_domains` 覆盖。

use std::net::IpAddr;
use std::time::Duration;

use chrono::Utc;
use url::Url;

use crate::builtin_tools::{BuiltinPolicy, BuiltinToolMeta};
use crate::http_client::{ProxyConfig, build_client};
use crate::model::config::TlsBackend;

/// fetch 成功返回结构（→ 合成为 web_fetch_tool_result 块的 content.content.source.data）
#[derive(Debug, Clone)]
pub struct FetchOk {
    /// 最终 URL（可能经过 redirect）
    pub url: String,
    /// 标题（HTML `<title>`，没解析到就是 None）
    pub title: Option<String>,
    /// 抓取时间，RFC3339 with microseconds
    pub retrieved_at: String,
    /// 转换后的 markdown
    pub markdown: String,
    /// 是否因 size_limit 被截断
    pub truncated: bool,
}

/// fetch 失败语义，对应 Anthropic `web_fetch_tool_result_error.error_code`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// URL 不可达（DNS/连接/HTTP 错）→ "url_not_accessible"
    UrlNotAccessible,
    /// 被管理员/客户端策略拦（私网/blocked_domains/scheme）→ "url_not_allowed"
    UrlNotAllowed,
    /// URL 格式无效 → "url_not_accessible"（Anthropic 不区分）
    InvalidUrl,
    /// 超时 → "url_not_accessible"
    Timeout,
    /// 上游返回非 2xx → "url_not_accessible"
    HttpStatus(u16),
}

impl FetchError {
    /// 映射到 Anthropic 协议的 error_code 字符串
    pub fn anthropic_error_code(&self) -> &'static str {
        match self {
            Self::UrlNotAccessible | Self::InvalidUrl | Self::Timeout | Self::HttpStatus(_) => {
                "url_not_accessible"
            }
            Self::UrlNotAllowed => "url_not_allowed",
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UrlNotAccessible => write!(f, "URL 不可达"),
            Self::UrlNotAllowed => write!(f, "URL 被策略拒绝"),
            Self::InvalidUrl => write!(f, "URL 格式无效"),
            Self::Timeout => write!(f, "请求超时"),
            Self::HttpStatus(code) => write!(f, "上游返回 HTTP {code}"),
        }
    }
}

/// 抓取 URL → markdown
///
/// 失败用 [`FetchError`] 表达，调用方按 Anthropic 协议合成 `web_fetch_tool_result_error`。
///
/// # 取舍
/// - 复用 [`build_client`] 让 fetch 走和 Kiro API 同样的代理/TLS 后端
/// - `truncated` 字段保留供合成端在 markdown 尾部追加说明
pub async fn fetch_url(
    url_str: &str,
    meta: &BuiltinToolMeta,
    policy: &BuiltinPolicy,
    proxy: Option<&ProxyConfig>,
    tls_backend: TlsBackend,
) -> Result<FetchOk, FetchError> {
    // 1. URL 解析 + scheme 检查
    let url = Url::parse(url_str).map_err(|_| FetchError::InvalidUrl)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::UrlNotAllowed);
    }

    // 2. 策略检查（管理员 + 客户端）
    let host = url.host_str().ok_or(FetchError::InvalidUrl)?;
    enforce_domain_policy(host, meta, policy)?;
    if policy.web_fetch_block_private_networks {
        enforce_no_private_ip(host)?;
    }

    // 3. 构造 client（复用全局 ProxyConfig）
    let client = build_client(proxy, policy.web_fetch_request_timeout_secs, tls_backend)
        .map_err(|_| FetchError::UrlNotAccessible)?;

    // 4. HTTP GET
    let resp = tokio::time::timeout(
        Duration::from_secs(policy.web_fetch_request_timeout_secs),
        client
            .get(url.as_str())
            .header("user-agent", "kiro-rs/1.0 (+web_fetch builtin)")
            .header("accept", "text/html,application/xhtml+xml,*/*;q=0.5")
            .send(),
    )
    .await
    .map_err(|_| FetchError::Timeout)?
    .map_err(|e| {
        if e.is_timeout() {
            FetchError::Timeout
        } else {
            FetchError::UrlNotAccessible
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        return Err(FetchError::HttpStatus(status.as_u16()));
    }

    let final_url = resp.url().to_string();

    // 5. 读取 body，带 size 上限
    let limit = policy.web_fetch_response_size_limit_bytes;
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| FetchError::UrlNotAccessible)?;
    let (body, truncated) = if bytes.len() > limit {
        (bytes.slice(..limit), true)
    } else {
        (bytes, false)
    };
    let html = String::from_utf8_lossy(&body).to_string();

    // 6. 提取 title + HTML→markdown
    let title = extract_title(&html);
    let markdown_raw = html2md::parse_html(&html);
    let markdown = truncate_to_char_budget(
        &markdown_raw,
        char_budget_from_tokens(policy.effective_max_content_tokens(meta)),
    );
    let truncated_by_size = truncated;
    let truncated_by_tokens = markdown.len() < markdown_raw.len();

    Ok(FetchOk {
        url: final_url,
        title,
        retrieved_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        markdown,
        truncated: truncated_by_size || truncated_by_tokens,
    })
}

/// 客户端 + 管理员策略检查
///
/// 优先级（高到低）：
/// 1. 管理员 `web_fetch_blocked_domains`（**硬底线，不可覆盖**）
/// 2. 客户端 `blocked_domains`
/// 3. 客户端 `allowed_domains`（指定时只放行白名单）
fn enforce_domain_policy(
    host: &str,
    meta: &BuiltinToolMeta,
    policy: &BuiltinPolicy,
) -> Result<(), FetchError> {
    let host_l = host.to_ascii_lowercase();

    // 1. 管理员黑名单（不可被客户端覆盖）
    if matches_any_domain(&host_l, &policy.web_fetch_blocked_domains) {
        return Err(FetchError::UrlNotAllowed);
    }

    // 2. 客户端黑名单
    if let Some(blocked) = &meta.blocked_domains
        && matches_any_domain(&host_l, blocked)
    {
        return Err(FetchError::UrlNotAllowed);
    }

    // 3. 客户端白名单（指定时只放行）
    if let Some(allowed) = &meta.allowed_domains
        && !allowed.is_empty()
        && !matches_any_domain(&host_l, allowed)
    {
        return Err(FetchError::UrlNotAllowed);
    }

    Ok(())
}

/// host 是否匹配某个 pattern（精确 host 或父域，如 `evil.com` 拦 `x.evil.com`）
fn matches_any_domain(host: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        let p_l = p.to_ascii_lowercase();
        host == p_l || host.ends_with(&format!(".{p_l}"))
    })
}

/// SSRF 防护：阻止指向私有 / loopback / link-local / 元数据服务的 host
///
/// 如果 host 是 IP 文字直接判；如果是域名，跳过（实际连接时 reqwest 走 DNS resolve，
/// 这里只做"显式 IP 地址"层的拦截，DNS rebinding 等高级攻击不在本工具防护范围）
fn enforce_no_private_ip(host: &str) -> Result<(), FetchError> {
    // 元数据服务的特殊域名（GCP/Azure 习惯用这个 host）
    const METADATA_HOSTS: &[&str] = &[
        "metadata.google.internal",
        "metadata.azure.internal",
        "instance-data.ec2.internal",
    ];
    let host_l = host.to_ascii_lowercase();
    if METADATA_HOSTS.contains(&host_l.as_str()) {
        return Err(FetchError::UrlNotAllowed);
    }

    // 尝试解析为 IP 字面量；域名形式跳过本检查（reqwest connect 时 DNS 由系统解析）
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        if is_blocked_ip(&ip) {
            return Err(FetchError::UrlNotAllowed);
        }
    }
    Ok(())
}

/// 是否是禁止的 IP（私有 / loopback / link-local / 元数据 / unspecified / multicast）
fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            // AWS EC2 元数据服务
            if v4.octets() == [169, 254, 169, 254] {
                return true;
            }
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_documentation()
                // CGNAT 100.64.0.0/10
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // ULA fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped → 解出来再检查
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_blocked_ip(&IpAddr::V4(v4)))
        }
    }
}

/// 朴素 `<title>` 提取（不处理嵌套实体，够用）
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    // 跳过 `<title ...>` 到 `>` 的部分
    let after_open = html[start..].find('>')? + start + 1;
    let end_rel = lower[after_open..].find("</title>")?;
    let raw = &html[after_open..after_open + end_rel];
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(decode_basic_entities(trimmed))
    }
}

fn decode_basic_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// token 上限 → 字符 budget 的粗估（4 字符 ≈ 1 token，再乘 0.9 安全余量）
fn char_budget_from_tokens(max_tokens: u32) -> usize {
    ((max_tokens as f64) * 4.0 * 0.9) as usize
}

/// UTF-8 安全截断到 max_chars 字节左右（找最近的 char 边界）
fn truncate_to_char_budget(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[... 内容已截断 ...]", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn meta_default() -> BuiltinToolMeta {
        BuiltinToolMeta {
            kind: crate::builtin_tools::BuiltinKind::WebFetch,
            anthropic_type: "web_fetch_20260209".to_string(),
            max_uses: None,
            allowed_domains: None,
            blocked_domains: None,
            max_content_tokens: None,
            citations_enabled: false,
        }
    }

    #[test]
    fn admin_blacklist_overrides_client_allowlist() {
        let policy = BuiltinPolicy {
            web_fetch_blocked_domains: vec!["evil.com".into()],
            ..Default::default()
        };
        let mut meta = meta_default();
        meta.allowed_domains = Some(vec!["evil.com".into(), "good.com".into()]);

        assert_eq!(
            enforce_domain_policy("evil.com", &meta, &policy),
            Err(FetchError::UrlNotAllowed)
        );
    }

    #[test]
    fn admin_blacklist_covers_subdomain() {
        let policy = BuiltinPolicy {
            web_fetch_blocked_domains: vec!["evil.com".into()],
            ..Default::default()
        };
        let meta = meta_default();
        assert_eq!(
            enforce_domain_policy("api.evil.com", &meta, &policy),
            Err(FetchError::UrlNotAllowed)
        );
    }

    #[test]
    fn client_blacklist_works() {
        let policy = BuiltinPolicy::default();
        let mut meta = meta_default();
        meta.blocked_domains = Some(vec!["bad.test".into()]);
        assert_eq!(
            enforce_domain_policy("bad.test", &meta, &policy),
            Err(FetchError::UrlNotAllowed)
        );
    }

    #[test]
    fn client_allowlist_only_lets_through_listed() {
        let policy = BuiltinPolicy::default();
        let mut meta = meta_default();
        meta.allowed_domains = Some(vec!["example.com".into()]);
        assert!(enforce_domain_policy("example.com", &meta, &policy).is_ok());
        assert!(enforce_domain_policy("sub.example.com", &meta, &policy).is_ok());
        assert_eq!(
            enforce_domain_policy("other.com", &meta, &policy),
            Err(FetchError::UrlNotAllowed)
        );
    }

    #[test]
    fn empty_allowlist_is_treated_as_no_restriction() {
        let policy = BuiltinPolicy::default();
        let mut meta = meta_default();
        meta.allowed_domains = Some(vec![]);
        assert!(enforce_domain_policy("anywhere.com", &meta, &policy).is_ok());
    }

    #[test]
    fn ssrf_blocks_loopback_v4() {
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(127, 100, 200, 1))));
    }

    #[test]
    fn ssrf_blocks_private_v4_ranges() {
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(172, 31, 255, 254))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
    }

    #[test]
    fn ssrf_blocks_link_local_and_ec2_metadata() {
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))));
    }

    #[test]
    fn ssrf_blocks_cgnat() {
        // 100.64.0.0/10
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(
            100, 127, 255, 254
        ))));
        // 100.128.0.0 不在 /10 范围
        assert!(!is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));
    }

    #[test]
    fn ssrf_blocks_ipv6_loopback_and_ula() {
        assert!(is_blocked_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_blocked_ip(&IpAddr::V6("fc00::1".parse().unwrap())));
        assert!(is_blocked_ip(&IpAddr::V6("fe80::1".parse().unwrap())));
    }

    #[test]
    fn ssrf_blocks_ipv4_mapped_ipv6() {
        // ::ffff:127.0.0.1 应被识别
        let mapped: Ipv6Addr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&IpAddr::V6(mapped)));
    }

    #[test]
    fn ssrf_allows_public_ipv4() {
        assert!(!is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn metadata_hostnames_blocked() {
        assert_eq!(
            enforce_no_private_ip("metadata.google.internal"),
            Err(FetchError::UrlNotAllowed)
        );
        assert_eq!(
            enforce_no_private_ip("METADATA.GOOGLE.INTERNAL"),
            Err(FetchError::UrlNotAllowed)
        );
    }

    #[test]
    fn domain_hosts_pass_ssrf_layer() {
        // 域名形式跳过 IP literal 层（实际 DNS resolve 不在 unit test 范围）
        assert!(enforce_no_private_ip("example.com").is_ok());
    }

    #[test]
    fn title_extraction() {
        let html = r#"<html><head><title>Hello &amp; World</title></head></html>"#;
        assert_eq!(extract_title(html), Some("Hello & World".to_string()));

        let no_title = "<html><body>nope</body></html>";
        assert_eq!(extract_title(no_title), None);

        let empty = "<title>  </title>";
        assert_eq!(extract_title(empty), None);
    }

    #[test]
    fn title_with_attributes() {
        let html = r#"<title id="t">Page</title>"#;
        assert_eq!(extract_title(html), Some("Page".to_string()));
    }

    #[test]
    fn error_code_mapping() {
        assert_eq!(
            FetchError::UrlNotAccessible.anthropic_error_code(),
            "url_not_accessible"
        );
        assert_eq!(
            FetchError::UrlNotAllowed.anthropic_error_code(),
            "url_not_allowed"
        );
        assert_eq!(
            FetchError::Timeout.anthropic_error_code(),
            "url_not_accessible"
        );
        assert_eq!(
            FetchError::HttpStatus(404).anthropic_error_code(),
            "url_not_accessible"
        );
        assert_eq!(
            FetchError::InvalidUrl.anthropic_error_code(),
            "url_not_accessible"
        );
    }

    #[test]
    fn truncate_keeps_utf8_boundary() {
        let s = "你好世界你好世界你好";
        let out = truncate_to_char_budget(s, 7);
        assert!(out.starts_with("你好"));
        assert!(out.contains("内容已截断"));
        // 不能在 char 中间截
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn truncate_passthrough_when_fits() {
        let s = "short";
        assert_eq!(truncate_to_char_budget(s, 100), "short");
    }
}
