//! 智谱（z.ai、bigmodel.cn，含 ZCode 套餐网关）的业务码与结束原因（docs/specs/rust-cli/provider-errors.md §5.3，修复线 F113）。
//!
//! 规则（D1 暂定）：码在表里就按表，不看 HTTP 状态；表外的码有 HTTP 状态时交给协议层；在 HTTP 200 的流里（没有状态）
//! 时是参数错误、不重试。码只认纯数字（`"code":"success"` 之类不算）。含义标“未核实”的码先按表收，以真实样本为准。
//! 厂商专有的码与字符串只在这个文件（`check:rust-cli` 的解耦检测）。

use rust_cli_base::proto::http;
use rust_cli_kernel_api::message::StopReason;
use rust_cli_kernel_api::model::{ModelError, ProviderFailure};
use serde_json::Value;

use super::{Class, Finish, Shape, Verdict, error_of, message_text};

/// 码 → 中性分类（§5.3 的两张表）与 Node 的 `reason` / `retryable`（`failure-provider-business-codes.ts`，
/// 夹具 `tests/fixtures/node-provider-codes.json`）。
const CODES: [(&str, Class, Terms); 42] = [
    (
        "500",
        Class::ServerError,
        Terms::Mapped("server_error", true),
    ),
    (
        "1008",
        Class::InvalidRequest,
        Terms::Mapped("unknown", false),
    ),
    (
        "1113",
        Class::QuotaExhausted,
        Terms::Mapped("unknown", false),
    ),
    (
        "1120",
        Class::ServerError,
        Terms::Mapped("server_error", true),
    ),
    ("1210", Class::InvalidRequest, Terms::Fallback),
    ("1211", Class::AccessDenied, Terms::Fallback),
    ("1213", Class::InvalidRequest, Terms::Fallback),
    ("1214", Class::AccessDenied, Terms::Fallback),
    (
        "1230",
        Class::ServerError,
        Terms::Mapped("server_error", true),
    ),
    ("1234", Class::Network, Terms::Mapped("network_error", true)),
    (
        "1261",
        Class::ContextOverflow,
        Terms::Mapped("context_exceeded", false),
    ),
    ("1301", Class::ContentBlocked, Terms::Fallback),
    (
        "1302",
        Class::RateLimited,
        Terms::Mapped("rate_limited", true),
    ),
    (
        "1303",
        Class::RateLimited,
        Terms::Mapped("rate_limited", true),
    ),
    (
        "1304",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1305",
        Class::RateLimited,
        Terms::Mapped("rate_limited", true),
    ),
    (
        "1308",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1309",
        Class::QuotaExhausted,
        Terms::Mapped("unknown", false),
    ),
    (
        "1310",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    ("1311", Class::AccessDenied, Terms::Mapped("unknown", false)),
    (
        "1312",
        Class::Overloaded,
        Terms::Mapped("provider_overloaded", true),
    ),
    (
        "1313",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1314",
        Class::QuotaExhausted,
        Terms::Mapped("unknown", false),
    ),
    (
        "1315",
        Class::QuotaExhausted,
        Terms::Mapped("unknown", false),
    ),
    (
        "1316",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1317",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1318",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1319",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1320",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1321",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "2056",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "20097",
        Class::QuotaExhausted,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "1005",
        Class::QuotaExhausted,
        Terms::Mapped("invalid_request", false),
    ),
    (
        "1006",
        Class::AuthRejected,
        Terms::Mapped("auth_failed", false),
    ),
    (
        "2007",
        Class::ServerError,
        Terms::Mapped("server_error", true),
    ),
    (
        "3001",
        Class::InvalidRequest,
        Terms::Mapped("invalid_request", false),
    ),
    (
        "3002",
        Class::RateLimited,
        Terms::Mapped("rate_limited", true),
    ),
    (
        "3006",
        Class::AccessDenied,
        Terms::Mapped("invalid_request", false),
    ),
    (
        "3007",
        Class::AccessDenied,
        Terms::Mapped("auth_failed", false),
    ),
    (
        "3008",
        Class::CapacityLimited,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "3009",
        Class::CapacityLimited,
        Terms::Mapped("rate_limited", false),
    ),
    (
        "3010",
        Class::CapacityLimited,
        Terms::Mapped("rate_limited", false),
    ),
];

/// Node's `reason` and `retryable` for a table code (`failure-provider-business-codes.ts`).
#[derive(Clone, Copy)]
enum Terms {
    /// Node maps the code: its reason and retryability, whatever the status.
    Mapped(&'static str, bool),
    /// Node does not map the code and classifies it by the HTTP status: a 429 is a rate limit that retries; without a
    /// status it is unknown and does not retry. Other statuses are not in the Node fixture.
    Fallback,
}

fn entry(code: &str) -> Option<(Class, Terms)> {
    CODES
        .iter()
        .find(|(known, _, _)| *known == code)
        .map(|(_, class, terms)| (*class, *terms))
}

fn class_of(code: &str) -> Option<Class> {
    entry(code).map(|(class, _)| class)
}

/// Node's `reason` and `retryable` for a code at `status`.
fn terms_of(terms: Terms, status: Option<u16>) -> (&'static str, bool) {
    match terms {
        Terms::Mapped(reason, retryable) => (reason, retryable),
        Terms::Fallback if status == Some(http::TOO_MANY_REQUESTS) => ("rate_limited", true),
        Terms::Fallback => ("unknown", false),
    }
}

/// 正文里的业务码：依次取 `providerCode`、`error_code`、`code`（先看 `error` 下的同名字段），再认消息开头的 `[1302]`。
/// 只认纯数字。
fn code(value: &Value, message: Option<&str>) -> Option<String> {
    let error = value.get("error").filter(|error| error.is_object());
    let numeric = |text: String| {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())).then_some(text)
    };
    for name in ["providerCode", "error_code", "code"] {
        for holder in [error, Some(value)].into_iter().flatten() {
            let found = match holder.get(name) {
                Some(Value::String(text)) => numeric(text.clone()),
                Some(Value::Number(number)) => numeric(number.to_string()),
                _ => None,
            };
            if found.is_some() {
                return found;
            }
        }
    }
    let rest = message?.trim_start().strip_prefix('[')?;
    numeric(rest.split_once(']')?.0.to_owned())
}

/// 端点给的消息：`error.message`、`message`、`msg`。
fn message_of(value: &Value) -> Option<&str> {
    let error = value.get("error").filter(|error| error.is_object());
    [error, Some(value)]
        .into_iter()
        .flatten()
        .find_map(|holder| {
            ["message", "msg"]
                .into_iter()
                .find_map(|name| holder.get(name).and_then(Value::as_str))
        })
}

/// `provider` is the business code the body carried with its Node terms and provider kind; the failure then names it.
fn verdict(
    class: Class,
    status: Option<u16>,
    value: &Value,
    raw: &str,
    retry_after_ms: Option<u64>,
    provider: Option<(&str, Terms, &'static str)>,
) -> Verdict {
    let message = message_text(status.unwrap_or(http::OK), message_of(value), raw);
    let shape = Shape {
        message,
        retry_after_ms,
    };
    let classified = error_of(class, status, shape);
    let error = match provider {
        Some((code, terms, kind)) => {
            let (reason, retryable) = terms_of(terms, status);
            ModelError::Provider {
                provider: Box::new(ProviderFailure::new(code, status, retryable, reason, kind)),
                error: Box::new(classified),
            }
        }
        None => classified,
    };
    Verdict::new(class, error)
}

/// 非 2xx 响应：码在表里时按表（不看状态）；否则交给协议层。`kind` is Node's `providerKind` for the protocol.
pub(super) fn response(
    status: u16,
    value: &Value,
    raw: &str,
    retry_after_ms: Option<u64>,
    kind: &'static str,
) -> Option<Verdict> {
    let code = code(value, message_of(value))?;
    let (class, terms) = entry(&code)?;
    Some(verdict(
        class,
        Some(status),
        value,
        raw,
        retry_after_ms,
        Some((&code, terms, kind)),
    ))
}

/// 流里的错误块：码在表里时按表；有码却不在表里时是参数错误（没有状态可看，不重试）；没有码时交给协议层。
pub(super) fn stream(value: &Value, raw: &str, kind: &'static str) -> Option<Verdict> {
    let code = code(value, message_of(value))?;
    let (class, terms) =
        entry(&code).unwrap_or((Class::InvalidRequest, Terms::Mapped("unknown", false)));
    Some(verdict(
        class,
        None,
        value,
        raw,
        None,
        Some((&code, terms, kind)),
    ))
}

/// 不带事件名的块：`success: false`，或带表里的码（带非错误的码的普通块不算）。
pub(super) fn frame(value: &Value, raw: &str, kind: &'static str) -> Option<Verdict> {
    let failed = value.get("success").and_then(Value::as_bool) == Some(false);
    let known = code(value, message_of(value)).is_some_and(|code| class_of(&code).is_some());
    if !failed && !known {
        return None;
    }
    Some(
        stream(value, raw, kind)
            .unwrap_or_else(|| verdict(Class::InvalidRequest, None, value, raw, None, None)),
    )
}

/// 智谱专有的结束原因（§5.3 的第三张表）：`sensitive` 是内容拦截；`network_error` 不是结束，是流内的网络失败
/// （以前是 `Unknown`，有输出时按正常完成，截断的内容不报）。
pub(super) fn finish(raw: &str) -> Option<Finish> {
    match raw {
        "sensitive" => Some(Finish::Stop(StopReason::Refusal)),
        "network_error" => Some(Finish::Failed(Verdict::new(
            Class::Network,
            ModelError::Network {
                message: "the provider reported a network error (finish_reason network_error)"
                    .to_owned(),
            },
        ))),
        _ => None,
    }
}

#[cfg(test)]
#[path = "zhipu_tests.rs"]
mod tests;
