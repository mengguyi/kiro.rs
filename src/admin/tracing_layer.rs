//! `tracing_subscriber::Layer` 实现：把每条事件镜像一份到 `console_log` 全局存储。
//!
//! 不替换 fmt 输出，与 fmt layer 并存（在 main.rs 用 `.with(...)` 组合）。

use std::fmt::Write;

use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;

use super::console_log::{ConsoleLogEntry, record};

pub struct ConsoleCapture;

impl ConsoleCapture {
    pub fn new() -> Self {
        Self
    }
}

impl<S> tracing_subscriber::Layer<S> for ConsoleCapture
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let target = metadata.target();

        // 防止 console_log / SSE handler 自身写日志触发回流
        if target.starts_with("kiro_rs::admin::console_log")
            || target.starts_with("kiro_rs::admin::tracing_layer")
        {
            return;
        }

        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let message = visitor.into_message();
        if message.is_empty() {
            return;
        }

        record(ConsoleLogEntry {
            time_ms: chrono::Utc::now().timestamp_millis(),
            level: metadata.level().to_string(),
            target: target.to_string(),
            message,
        });
    }
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: String,
}

impl MessageVisitor {
    fn into_message(mut self) -> String {
        if !self.fields.is_empty() {
            if !self.message.is_empty() {
                self.message.push(' ');
            }
            self.message.push_str(&self.fields);
        }
        self.message
    }
}

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let name = field.name();
        if name == "message" {
            // Debug 格式可能多一层引号，去掉外层引号让显示更干净
            let raw = format!("{:?}", value);
            self.message = strip_surrounding_quotes(&raw).to_string();
        } else {
            let _ = write!(self.fields, " {}={:?}", name, value);
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            let _ = write!(self.fields, " {}={}", field.name(), value);
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            let _ = write!(self.fields, " {}={}", field.name(), value);
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            let _ = write!(self.fields, " {}={}", field.name(), value);
        }
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            let _ = write!(self.fields, " {}={}", field.name(), value);
        }
    }
}

fn strip_surrounding_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        &s[1..s.len() - 1]
    } else {
        s
    }
}
