//! Structured engine errors (Node `engine/errors.ts`): stable codes and the journal shape `toJSON` writes.
//!
//! Only the codes the W5a lifecycle reaches are listed; the rest of the union is added with the
//! code that raises it. Messages are copied verbatim: they land in `failure_json` and event payloads.
use serde_json::{Map, Value};

/// Stable error codes (Node `WorkflowErrorCode`), the subset W5a raises or stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    DriverError,
    Cancelled,
    ScriptHashMismatch,
    Interrupted,
    ProviderStop,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DriverError => "DriverError",
            Self::Cancelled => "Cancelled",
            Self::ScriptHashMismatch => "ScriptHashMismatch",
            Self::Interrupted => "Interrupted",
            Self::ProviderStop => "ProviderStop",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "DriverError" => Self::DriverError,
            "Cancelled" => Self::Cancelled,
            "ScriptHashMismatch" => Self::ScriptHashMismatch,
            "Interrupted" => Self::Interrupted,
            "ProviderStop" => Self::ProviderStop,
            _ => return None,
        })
    }
}

impl std::fmt::Display for WorkflowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WorkflowError {}

/// Node `WorkflowError`: a code and a message, with the optional structured parts the journal keeps.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowError {
    pub code: ErrorCode,
    pub message: String,
    /// Structured details for `ProviderStop` and friends, kept as the JSON the journal stores.
    pub extra: Option<Value>,
}

impl WorkflowError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            extra: None,
        }
    }

    /// Node `WorkflowError.toJSON`: `code` and `message`, then the optional parts in that order.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".into(), Value::String(self.code.as_str().into()));
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(extra) = &self.extra {
            map.insert("providerStop".into(), extra.clone());
        }
        Value::Object(map)
    }

    /// Node `WorkflowError.fromJSON` for the fields W5a keeps.
    pub fn from_json(json: &Value) -> Option<Self> {
        let code = ErrorCode::parse(json.get("code")?.as_str()?)?;
        let message = json.get("message")?.as_str()?.to_owned();
        Some(Self {
            code,
            message,
            extra: json.get("providerStop").cloned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_json_keeps_code_then_message_and_round_trips() {
        let error = WorkflowError::new(ErrorCode::Cancelled, "Run stopped.");
        assert_eq!(
            error.to_json(),
            json!({"code": "Cancelled", "message": "Run stopped."})
        );
        assert_eq!(WorkflowError::from_json(&error.to_json()), Some(error));
    }

    #[test]
    fn unknown_codes_do_not_parse() {
        assert_eq!(ErrorCode::parse("Bogus"), None);
    }
}
