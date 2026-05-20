//! 请求日志环形缓冲（全局内存级）
//!
//! 业务请求生命周期由 `anthropic::log_middleware` 包裹，结束时写入此缓冲。
//! Admin API 通过 `GET /api/admin/requests` 读取。
//!
//! - 容量固定，超过即丢最旧（FIFO）
//! - 仅内存，重启清零
//! - 全局 `OnceLock<Arc<...>>`，沿用 `crate::token::COUNT_TOKENS_CONFIG` 的模式

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::Serialize;

const DEFAULT_CAPACITY: usize = 500;

/// 单条请求日志
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogEntry {
    /// Unix 毫秒时间戳
    pub time_ms: i64,
    /// 请求 ID（短随机串或客户端传入的 x-request-id 截断）
    pub req_id: String,
    /// HTTP 方法
    pub method: String,
    /// 请求路径
    pub path: String,
    /// HTTP 状态码（流式响应总是 200，流内错误不在此体现）
    pub status: u16,
    /// 处理耗时（毫秒）
    pub latency_ms: u32,
}

/// 环形日志缓冲
pub struct RequestLogBuffer {
    buf: Mutex<VecDeque<RequestLogEntry>>,
    capacity: usize,
}

impl RequestLogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    pub fn push(&self, entry: RequestLogEntry) {
        let mut buf = self.buf.lock();
        if buf.len() >= self.capacity {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    /// 倒序返回（最新在前），可选限制条数 / 仅返回 time_ms > since_ms 的
    pub fn list(&self, limit: Option<usize>, since_ms: Option<i64>) -> Vec<RequestLogEntry> {
        let buf = self.buf.lock();
        let iter = buf.iter().rev().filter(|e| match since_ms {
            Some(ts) => e.time_ms > ts,
            None => true,
        });
        match limit {
            Some(n) => iter.take(n).cloned().collect(),
            None => iter.cloned().collect(),
        }
    }

    pub fn clear(&self) {
        self.buf.lock().clear();
    }
}

static GLOBAL: OnceLock<Arc<RequestLogBuffer>> = OnceLock::new();

/// 启动时调用一次。重复调用安全（OnceLock 仅生效首次）。
pub fn init() -> Arc<RequestLogBuffer> {
    let buf = Arc::new(RequestLogBuffer::new(DEFAULT_CAPACITY));
    let _ = GLOBAL.set(buf.clone());
    GLOBAL.get().cloned().unwrap_or(buf)
}

/// 全局 push（未 init 时静默忽略）
pub fn record(entry: RequestLogEntry) {
    if let Some(buf) = GLOBAL.get() {
        buf.push(entry);
    }
}

/// 全局 list（未 init 时返回空）
pub fn list(limit: Option<usize>, since_ms: Option<i64>) -> Vec<RequestLogEntry> {
    GLOBAL
        .get()
        .map(|b| b.list(limit, since_ms))
        .unwrap_or_default()
}
