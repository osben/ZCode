//! Structured engine errors (Node `engine/errors.ts`): stable codes and the journal shape `toJSON` writes.
//!
//! Messages are copied verbatim: they land in `failure_json` and event payloads. `to_json` keeps Node's
//! key order: code, message, violations, finalText, mismatch, providerStop.
use crate::model::Violation;
use serde_json::{Map, Value};

/// Stable error codes (Node `WorkflowErrorCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    ValidationFailed,
    ResultNotSubmitted,
    DriverError,
    Cancelled,
    InputHashMismatch,
    UnknownActor,
    MissingAskSpec,
    DuplicateActorName,
    ScriptHashMismatch,
    Interrupted,
    ProviderStop,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ValidationFailed => "ValidationFailed",
            Self::ResultNotSubmitted => "ResultNotSubmitted",
            Self::DriverError => "DriverError",
            Self::Cancelled => "Cancelled",
            Self::InputHashMismatch => "InputHashMismatch",
            Self::UnknownActor => "UnknownActor",
            Self::MissingAskSpec => "MissingAskSpec",
            Self::DuplicateActorName => "DuplicateActorName",
            Self::ScriptHashMismatch => "ScriptHashMismatch",
            Self::Interrupted => "Interrupted",
            Self::ProviderStop => "ProviderStop",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "ValidationFailed" => Self::ValidationFailed,
            "ResultNotSubmitted" => Self::ResultNotSubmitted,
            "DriverError" => Self::DriverError,
            "Cancelled" => Self::Cancelled,
            "InputHashMismatch" => Self::InputHashMismatch,
            "UnknownActor" => Self::UnknownActor,
            "MissingAskSpec" => Self::MissingAskSpec,
            "DuplicateActorName" => Self::DuplicateActorName,
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

/// Node `mismatch` on `InputHashMismatch` and `ScriptHashMismatch`: the two hashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub expected: String,
    pub got: String,
}

/// Node `WorkflowError`: a code and a message, with the optional structured parts the journal keeps.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowError {
    pub code: ErrorCode,
    pub message: String,
    pub violations: Option<Vec<Violation>>,
    pub final_text: Option<String>,
    pub mismatch: Option<Mismatch>,
    /// `ProviderStopDetails`, kept as the JSON the journal stores.
    pub provider_stop: Option<Value>,
}

impl WorkflowError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            violations: None,
            final_text: None,
            mismatch: None,
            provider_stop: None,
        }
    }

    /// Node `WorkflowError.toJSON`, in Node's key order.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".into(), Value::String(self.code.as_str().into()));
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(violations) = &self.violations {
            map.insert(
                "violations".into(),
                Value::Array(violations.iter().map(Violation::to_json).collect()),
            );
        }
        if let Some(text) = &self.final_text {
            map.insert("finalText".into(), Value::String(text.clone()));
        }
        if let Some(mismatch) = &self.mismatch {
            let mut inner = Map::new();
            inner.insert("expected".into(), Value::String(mismatch.expected.clone()));
            inner.insert("got".into(), Value::String(mismatch.got.clone()));
            map.insert("mismatch".into(), Value::Object(inner));
        }
        if let Some(stop) = &self.provider_stop {
            map.insert("providerStop".into(), stop.clone());
        }
        Value::Object(map)
    }

    /// Node `WorkflowError.fromJSON`. Returns `None` for a code or shape this build does not know: the
    /// journal row came from a newer build, and the caller must not guess.
    pub fn from_json(json: &Value) -> Option<Self> {
        let code = ErrorCode::parse(json.get("code")?.as_str()?)?;
        let message = json.get("message")?.as_str()?.to_owned();
        let violations = match json.get("violations") {
            None => None,
            Some(list) => Some(
                list.as_array()?
                    .iter()
                    .map(Violation::from_json)
                    .collect::<Option<Vec<_>>>()?,
            ),
        };
        let mismatch = match json.get("mismatch") {
            None => None,
            Some(inner) => Some(Mismatch {
                expected: inner.get("expected")?.as_str()?.to_owned(),
                got: inner.get("got")?.as_str()?.to_owned(),
            }),
        };
        Some(Self {
            code,
            message,
            violations,
            final_text: json
                .get("finalText")
                .and_then(Value::as_str)
                .map(str::to_owned),
            mismatch,
            provider_stop: json.get("providerStop").cloned(),
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
    fn optional_parts_follow_node_key_order() {
        let error = WorkflowError {
            violations: Some(vec![Violation {
                path: "$".into(),
                expected: "string".into(),
                got: "number".into(),
            }]),
            final_text: Some("text".into()),
            mismatch: Some(Mismatch {
                expected: "a".into(),
                got: "b".into(),
            }),
            ..WorkflowError::new(ErrorCode::InputHashMismatch, "m")
        };
        assert_eq!(
            serde_json::to_string(&error.to_json()).unwrap(),
            r#"{"code":"InputHashMismatch","message":"m","violations":[{"path":"$","expected":"string","got":"number"}],"finalText":"text","mismatch":{"expected":"a","got":"b"}}"#
        );
        assert_eq!(WorkflowError::from_json(&error.to_json()), Some(error));
    }

    #[test]
    fn unknown_codes_do_not_parse() {
        assert_eq!(ErrorCode::parse("Bogus"), None);
        assert_eq!(
            WorkflowError::from_json(&json!({"code": "Bogus", "message": "x"})),
            None
        );
    }
}
