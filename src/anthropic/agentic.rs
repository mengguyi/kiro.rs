//! Agentic 流处理（M6）
//!
//! `handle_stream_request` 的内核：用 mpsc-driven 任务驱动多轮 AWS Q 调用，
//! 中间检测 [`StreamContext::take_pending_intercept`] → 本地执行 builtin（如 web_fetch）
//! → 合成 `*_tool_result` SSE 块给客户端 → 续写 Anthropic messages → 重发 AWS Q 继续生成。
//!
//! 对客户端而言整个过程透明：单次 SSE 流，行为同 Anthropic 原生 server tool。

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::interval;
use tokio_stream::wrappers::ReceiverStream;

use crate::builtin_tools::{BuiltinPolicy, web_fetch};
use crate::http_client::ProxyConfig;
use crate::kiro::model::events::Event;
use crate::kiro::model::requests::kiro::KiroRequest;
use crate::kiro::parser::decoder::EventStreamDecoder;
use crate::kiro::provider::KiroProvider;
use crate::model::config::TlsBackend;

use super::converter::{ConversionResult, convert_request};
use super::stream::StreamContext;
use super::types::{ErrorResponse, MessagesRequest};

/// Ping 事件间隔 — 同原实现，防反代切流
const PING_INTERVAL_SECS: u64 = 25;

/// agentic loop 启动参数
pub struct AgenticArgs {
    pub provider: Arc<KiroProvider>,
    pub initial_request_body: String,
    pub payload: MessagesRequest,
    pub conversion: ConversionResult,
    pub thinking_enabled: bool,
    pub credential_id: Option<u64>,
    pub policy: BuiltinPolicy,
    pub proxy: Option<ProxyConfig>,
    pub tls_backend: TlsBackend,
    pub input_tokens: i32,
}

/// 启动 agentic 流处理，返回 HTTP Response（body 是 mpsc-driven SSE 流）
pub fn handle(args: AgenticArgs) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, Infallible>>(64);
    let has_builtin = !args.conversion.builtin_tools.is_empty();

    if !has_builtin {
        // 无 builtin → 走快路径（不重发，等价于原 handle_stream_request 行为）
        tokio::spawn(run_passthrough(tx, args));
    } else {
        // 有 builtin → 启动 agentic loop
        tokio::spawn(run_agentic(tx, args));
    }

    let stream = ReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// 简单 passthrough：无 builtin 时，调一次 AWS Q + 全程转发
async fn run_passthrough(tx: mpsc::Sender<Result<Bytes, Infallible>>, args: AgenticArgs) {
    let mut ctx = StreamContext::new_with_thinking(
        args.payload.model.clone(),
        args.input_tokens,
        args.thinking_enabled,
        args.conversion.tool_name_map,
    );
    for ev in ctx.generate_initial_events() {
        if tx.send(Ok(Bytes::from(ev.to_sse_string()))).await.is_err() {
            return;
        }
    }

    let response = match args
        .provider
        .call_api_stream(&args.initial_request_body, args.credential_id)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            send_provider_error(&tx, e).await;
            return;
        }
    };

    consume_response(&tx, &mut ctx, response).await;

    flush_finals(&tx, &mut ctx).await;
}

/// agentic loop：支持检测 builtin → fetch → 续写 → 重发
async fn run_agentic(tx: mpsc::Sender<Result<Bytes, Infallible>>, args: AgenticArgs) {
    let AgenticArgs {
        provider,
        initial_request_body,
        mut payload,
        mut conversion,
        thinking_enabled,
        credential_id,
        policy,
        proxy,
        tls_backend,
        input_tokens,
    } = args;

    let mut ctx = StreamContext::new_with_thinking(
        payload.model.clone(),
        input_tokens,
        thinking_enabled,
        conversion.tool_name_map.clone(),
    )
    .with_builtin_registry(conversion.builtin_tools.clone());

    for ev in ctx.generate_initial_events() {
        if tx.send(Ok(Bytes::from(ev.to_sse_string()))).await.is_err() {
            return;
        }
    }

    let mut req_body = initial_request_body;
    let mut iter: u32 = 0;
    let hard_limit = policy.web_fetch_max_uses_hard_limit.max(1);

    loop {
        iter += 1;
        tracing::debug!("agentic iter #{} 发起 AWS Q 请求", iter);

        let response = match provider.call_api_stream(&req_body, credential_id).await {
            Ok(r) => r,
            Err(e) => {
                send_provider_error(&tx, e).await;
                break;
            }
        };

        consume_response(&tx, &mut ctx, response).await;

        let Some(p) = ctx.take_pending_intercept() else {
            // 流自然结束，模型没再调 builtin
            break;
        };

        // hard limit
        if iter >= hard_limit {
            tracing::warn!(
                "agentic iter #{} 达到硬上限 {}，强制以 url_not_accessible 终止",
                iter, hard_limit
            );
            let evs = ctx.emit_web_fetch_result_error(
                &p.srv_tool_use_id,
                &web_fetch::FetchError::UrlNotAccessible,
            );
            send_all(&tx, evs).await;
            break;
        }

        // 解析 input JSON
        let input_val: serde_json::Value =
            serde_json::from_str(&p.input_json).unwrap_or(json!({}));
        let url = input_val
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // 查 meta
        let meta = match conversion.builtin_tools.get(&p.builtin_name).cloned() {
            Some(m) => m,
            None => {
                tracing::error!("builtin {} 不在 registry 中（不应发生）", p.builtin_name);
                let evs = ctx.emit_web_fetch_result_error(
                    &p.srv_tool_use_id,
                    &web_fetch::FetchError::UrlNotAccessible,
                );
                send_all(&tx, evs).await;
                break;
            }
        };

        // 执行 fetch
        tracing::info!("agentic 执行 web_fetch url={}", url);
        let fetch_result =
            web_fetch::fetch_url(&url, &meta, &policy, proxy.as_ref(), tls_backend).await;

        // 合成 tool_result SSE 块
        let (result_evs, tool_result_text_for_model) = match &fetch_result {
            Ok(ok) => (
                ctx.emit_web_fetch_result_success(&p.srv_tool_use_id, ok),
                ok.markdown.clone(),
            ),
            Err(e) => (
                ctx.emit_web_fetch_result_error(&p.srv_tool_use_id, e),
                format!("Error fetching {url}: {e}"),
            ),
        };
        send_all(&tx, result_evs).await;

        // 续写 messages，触发第二次请求
        payload.messages.push(super::types::Message {
            role: "assistant".to_string(),
            content: json!([{
                "type": "tool_use",
                "id": p.tool_use_id,
                "name": p.builtin_name,
                "input": input_val,
            }]),
        });
        payload.messages.push(super::types::Message {
            role: "user".to_string(),
            content: json!([{
                "type": "tool_result",
                "tool_use_id": p.tool_use_id,
                "content": tool_result_text_for_model,
            }]),
        });

        // 重新 convert（保留同样的 builtin_tools registry — internal name 不变）
        let new_conv = match convert_request(&payload) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("续写后重新 convert 失败: {}", e);
                break;
            }
        };
        let kiro_req = KiroRequest {
            conversation_state: new_conv.conversation_state,
            profile_arn: None,
        };
        match serde_json::to_string(&kiro_req) {
            Ok(s) => req_body = s,
            Err(e) => {
                tracing::error!("序列化续写请求失败: {}", e);
                break;
            }
        }
        // 复用 ctx 的 builtin_registry（internal name 不变；agentic 状态机连续）
        // tool_name_map 同步更新（虽然 builtin 不走 short-name 映射，但 conversion 可能新加 placeholder tool）
        conversion.tool_name_map = new_conv.tool_name_map;
    }

    flush_finals(&tx, &mut ctx).await;
}

/// 消费一轮 AWS Q SSE 响应：解码 → ctx.process_kiro_event → 发给客户端
/// 收到 builtin pending_intercept 时立即返回（让外层 agentic loop 处理）
///
/// 期间每 25s 发 ping 保活
async fn consume_response(
    tx: &mpsc::Sender<Result<Bytes, Infallible>>,
    ctx: &mut StreamContext,
    response: reqwest::Response,
) {
    let mut body_stream = response.bytes_stream();
    let mut decoder = EventStreamDecoder::new();
    let mut ping_interval = interval(Duration::from_secs(PING_INTERVAL_SECS));
    // 第一次 tick 立即触发，跳过它避免 connection 一打开就发 ping
    ping_interval.tick().await;

    loop {
        tokio::select! {
            chunk_result = body_stream.next() => {
                match chunk_result {
                    Some(Ok(chunk)) => {
                        if let Err(e) = decoder.feed(&chunk) {
                            tracing::warn!("解码器缓冲溢出: {}", e);
                        }
                        for frame_result in decoder.decode_iter() {
                            match frame_result {
                                Ok(frame) => {
                                    if let Ok(event) = Event::from_frame(frame) {
                                        let evs = ctx.process_kiro_event(&event);
                                        send_all(tx, evs).await;
                                    }
                                }
                                Err(e) => tracing::warn!("帧解码失败: {}", e),
                            }
                        }
                        if ctx.has_pending_intercept() {
                            // 退出本轮，让 agentic 外层处理
                            return;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::warn!("读取上游流失败: {}", e);
                        return;
                    }
                    None => {
                        return; // 自然结束
                    }
                }
            }
            _ = ping_interval.tick() => {
                let ping = Bytes::from("event: ping\ndata: {\"type\": \"ping\"}\n\n");
                if tx.send(Ok(ping)).await.is_err() {
                    return; // 客户端断开
                }
            }
        }
    }
}

/// 发送一批 SseEvent 到 channel
async fn send_all(
    tx: &mpsc::Sender<Result<Bytes, Infallible>>,
    events: Vec<super::stream::SseEvent>,
) {
    for ev in events {
        if tx.send(Ok(Bytes::from(ev.to_sse_string()))).await.is_err() {
            return;
        }
    }
}

/// 发送 generate_final_events（含 message_delta + message_stop）
async fn flush_finals(tx: &mpsc::Sender<Result<Bytes, Infallible>>, ctx: &mut StreamContext) {
    let finals = ctx.generate_final_events();
    send_all(tx, finals).await;
}

/// provider 错误 → 把 Anthropic 风格错误 JSON 当成一个 message 块吐给客户端
///
/// SSE 已经开始（message_start 发过），此时 HTTP status 锁定为 200。
/// 用 `event: error` 帧表达错误更接近 Anthropic 协议。
async fn send_provider_error(tx: &mpsc::Sender<Result<Bytes, Infallible>>, e: anyhow::Error) {
    tracing::error!("provider 错误: {}", e);
    let msg = e.to_string();
    let err_event = format!(
        "event: error\ndata: {}\n\n",
        serde_json::to_string(&json!({
            "type": "error",
            "error": {
                "type": "api_error",
                "message": msg
            }
        }))
        .unwrap_or_else(|_| "{}".to_string())
    );
    let _ = tx.send(Ok(Bytes::from(err_event))).await;
}

/// 给 [`Response`] builder 一个错误的快捷构造（在 provider 完全不可用时用）
pub fn provider_unavailable_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ErrorResponse::new(
            "service_unavailable",
            "Kiro API provider not configured",
        )),
    )
        .into_response()
}
