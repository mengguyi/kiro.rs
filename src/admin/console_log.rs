//! 控制台日志捕获
//!
//! 把 `tracing` 输出（控制台看到的 INFO/WARN/ERROR 行）镜像一份到两个出口：
//! 1. 一个 ring buffer（最近 N 条，给 GET /api/admin/console-recent 拿历史）
//! 2. 一个 `tokio::sync::broadcast` channel（给 SSE 实时推流）
//!
//! `crate::admin::tracing_layer::ConsoleCapture` 是写入侧，
//! `crate::admin::handlers::get_console_stream` 是订阅侧。

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::broadcast;

const RECENT_CAPACITY: usize = 500;
const BROADCAST_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLogEntry {
    pub time_ms: i64,
    /// "INFO" / "WARN" / "ERROR" / "DEBUG" / "TRACE"
    pub level: String,
    /// tracing target (模块路径，如 "kiro_rs::kiro::provider")
    pub target: String,
    /// 实际消息文本（已格式化）
    pub message: String,
}

static SENDER: OnceLock<broadcast::Sender<ConsoleLogEntry>> = OnceLock::new();
static RECENT: OnceLock<Arc<Mutex<VecDeque<ConsoleLogEntry>>>> = OnceLock::new();

/// 启动时调用一次。tracing subscriber 注册前调，保证后面写入不会丢。
pub fn init() {
    let (tx, _rx) = broadcast::channel::<ConsoleLogEntry>(BROADCAST_CAPACITY);
    let _ = SENDER.set(tx);
    let _ = RECENT.set(Arc::new(Mutex::new(VecDeque::with_capacity(
        RECENT_CAPACITY,
    ))));
}

/// 写入一条日志（Tracing Layer 调用）。
pub fn record(entry: ConsoleLogEntry) {
    if let Some(recent) = RECENT.get() {
        let mut buf = recent.lock();
        if buf.len() >= RECENT_CAPACITY {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
    }
    if let Some(tx) = SENDER.get() {
        // 没订阅者会返回 Err，忽略
        let _ = tx.send(entry);
    }
}

/// 拿历史快照（倒序，最新在前）。
pub fn list_recent(limit: Option<usize>) -> Vec<ConsoleLogEntry> {
    let Some(recent) = RECENT.get() else {
        return Vec::new();
    };
    let buf = recent.lock();
    let iter = buf.iter().rev();
    match limit {
        Some(n) => iter.take(n).cloned().collect(),
        None => iter.cloned().collect(),
    }
}

/// 订阅实时流（SSE 用）。
pub fn subscribe() -> Option<broadcast::Receiver<ConsoleLogEntry>> {
    SENDER.get().map(|s| s.subscribe())
}

/// 清空历史缓冲（已订阅的 SSE 流不受影响——broadcast 通道不清，只清 ring buffer）。
pub fn clear() {
    if let Some(recent) = RECENT.get() {
        recent.lock().clear();
    }
}
