//! 业务请求日志中间件
//!
//! 包裹所有 `/v1` 与 `/cc/v1` 路由，记录方法/路径/状态/耗时到全局日志缓冲。
//!
//! 已知局限：流式响应 status 永远是 200，stream 内部错误目前不被捕获。

use std::time::Instant;

use axum::{extract::Request, middleware::Next, response::Response};
use chrono::Utc;
use uuid::Uuid;

use crate::admin::request_log::{RequestLogEntry, record};

const REQ_ID_HEADER: &str = "x-request-id";

pub async fn request_log_middleware(request: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();

    let req_id = request
        .headers()
        .get(REQ_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string()[..8].to_string());

    let response = next.run(request).await;

    let latency_ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;
    let status = response.status().as_u16();

    record(RequestLogEntry {
        time_ms: Utc::now().timestamp_millis(),
        req_id,
        method,
        path,
        status,
        latency_ms,
    });

    response
}
