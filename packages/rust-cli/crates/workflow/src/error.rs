//! Structured engine errors (Node `engine/errors.ts`): stable codes and the journal shape `toJSON` writes.
//!
//! Only the codes the W5a lifecycle and scheduler reach are listed; the rest of the union is added with
//! the code that raises it. Messages are copied verbatim: they land in `failure_json` and event payloads.
//! The optional parts follow Node's `WorkflowErrorJson` and are written in its `toJSON` order.
use crate::model::Violation;
use serde_json::{Map, Value};

/// Stable error codes (Node `WorkflowErrorCode`), the subset the scheduler and lifecycle raise or store.
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
    ReportCapExceeded,
    ArtifactSourceMissing,
    ArtifactPathOutsideWorkspace,
    ArtifactTooLarge,
    ArtifactStoreUnavailable,
    ArtifactVersionCapExceeded,
    ArtifactKindMismatch,
    ArtifactCapExceeded,
    ArtifactSpecInvalid,
    ArtifactRedeclared,
    ArtifactUndeclared,
    ArtifactPrimaryConflict,
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
            Self::ReportCapExceeded => "ReportCapExceeded",
            Self::ArtifactSourceMissing => "ArtifactSourceMissing",
            Self::ArtifactPathOutsideWorkspace => "ArtifactPathOutsideWorkspace",
            Self::ArtifactTooLarge => "ArtifactTooLarge",
            Self::ArtifactStoreUnavailable => "ArtifactStoreUnavailable",
            Self::ArtifactVersionCapExceeded => "ArtifactVersionCapExceeded",
            Self::ArtifactKindMismatch => "ArtifactKindMismatch",
            Self::ArtifactCapExceeded => "ArtifactCapExceeded",
            Self::ArtifactSpecInvalid => "ArtifactSpecInvalid",
            Self::ArtifactRedeclared => "ArtifactRedeclared",
            Self::ArtifactUndeclared => "ArtifactUndeclared",
            Self::ArtifactPrimaryConflict => "ArtifactPrimaryConflict",
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
            "ReportCapExceeded" => Self::ReportCapExceeded,
            "ArtifactSourceMissing" => Self::ArtifactSourceMissing,
            "ArtifactPathOutsideWorkspace" => Self::ArtifactPathOutsideWorkspace,
            "ArtifactTooLarge" => Self::ArtifactTooLarge,
            "ArtifactStoreUnavailable" => Self::ArtifactStoreUnavailable,
            "ArtifactVersionCapExceeded" => Self::ArtifactVersionCapExceeded,
            "ArtifactKindMismatch" => Self::ArtifactKindMismatch,
            "ArtifactCapExceeded" => Self::ArtifactCapExceeded,
            "ArtifactSpecInvalid" => Self::ArtifactSpecInvalid,
            "ArtifactRedeclared" => Self::ArtifactRedeclared,
            "ArtifactUndeclared" => Self::ArtifactUndeclared,
            "ArtifactPrimaryConflict" => Self::ArtifactPrimaryConflict,
            _ => return None,
        })
    }
}

/// Node `WorkflowErrorMismatch`: the recorded value (`expected`) and the current input (`got`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub expected: String,
    pub got: String,
}

/// Node `WorkflowError`: a code and a message, with the optional structured parts the journal keeps.
///
/// `violations` and `provider_stop` stay JSON values, as stored, until their owners port the types;
/// `final_text` and `mismatch` are typed.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowError {
    pub code: ErrorCode,
    pub message: String,
    pub violations: Option<Value>,
    pub final_text: Option<String>,
    pub mismatch: Option<Mismatch>,
    /// Node `providerStop`, present only for `ProviderStop` errors (the details object as stored).
    pub provider_stop: Option<Value>,
}

impl std::fmt::Display for WorkflowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WorkflowError {}

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

    /// Node `new WorkflowError(code, message, { mismatch: { expected, got } })`.
    pub fn with_mismatch(mut self, expected: impl Into<String>, got: impl Into<String>) -> Self {
        self.mismatch = Some(Mismatch {
            expected: expected.into(),
            got: got.into(),
        });
        self
    }

    /// Node `new WorkflowError(code, message, { providerStop })`.
    pub fn with_provider_stop(mut self, details: Value) -> Self {
        self.provider_stop = Some(details);
        self
    }

    /// Node `new WorkflowError(code, message, { violations })`: the violations in their JSON shape.
    pub fn with_violations(mut self, violations: &[Violation]) -> Self {
        self.violations = Some(Value::Array(
            violations.iter().map(Violation::to_json).collect(),
        ));
        self
    }

    /// Node `new WorkflowError(code, message, { finalText })`.
    pub fn with_final_text(mut self, final_text: impl Into<String>) -> Self {
        self.final_text = Some(final_text.into());
        self
    }

    /// Node `WorkflowError.toJSON`: `code` and `message`, then `violations`, `finalText`, `mismatch`
    /// and `providerStop`, each only when set.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".into(), Value::String(self.code.as_str().into()));
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(violations) = &self.violations {
            map.insert("violations".into(), violations.clone());
        }
        if let Some(final_text) = &self.final_text {
            map.insert("finalText".into(), Value::String(final_text.clone()));
        }
        if let Some(mismatch) = &self.mismatch {
            let mut inner = Map::new();
            inner.insert("expected".into(), Value::String(mismatch.expected.clone()));
            inner.insert("got".into(), Value::String(mismatch.got.clone()));
            map.insert("mismatch".into(), Value::Object(inner));
        }
        if let Some(provider_stop) = &self.provider_stop {
            map.insert("providerStop".into(), provider_stop.clone());
        }
        Value::Object(map)
    }

    /// Node `WorkflowError.fromJSON` for the fields W5a keeps. A malformed `mismatch` is dropped.
    pub fn from_json(json: &Value) -> Option<Self> {
        let code = ErrorCode::parse(json.get("code")?.as_str()?)?;
        let message = json.get("message")?.as_str()?.to_owned();
        let mismatch = json.get("mismatch").and_then(|m| {
            Some(Mismatch {
                expected: m.get("expected")?.as_str()?.to_owned(),
                got: m.get("got")?.as_str()?.to_owned(),
            })
        });
        Some(Self {
            code,
            message,
            violations: json.get("violations").cloned(),
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
    fn optional_parts_are_written_in_node_order() {
        let error = WorkflowError::new(ErrorCode::ProviderStop, "stopped")
            .with_mismatch("h1", "h2")
            .with_provider_stop(json!({"phase": "plan"}));
        let text = serde_json::to_string(&error.to_json()).unwrap();
        assert_eq!(
            text,
            r#"{"code":"ProviderStop","message":"stopped","mismatch":{"expected":"h1","got":"h2"},"providerStop":{"phase":"plan"}}"#
        );
        assert_eq!(WorkflowError::from_json(&error.to_json()), Some(error));
    }

    #[test]
    fn violations_and_final_text_follow_message_in_node_order() {
        let violation = Violation {
            path: "$".into(),
            expected: "string".into(),
            got: "number".into(),
        };
        let error = WorkflowError::new(ErrorCode::ValidationFailed, "m")
            .with_violations(&[violation])
            .with_final_text("text");
        assert_eq!(
            serde_json::to_string(&error.to_json()).unwrap(),
            r#"{"code":"ValidationFailed","message":"m","violations":[{"path":"$","expected":"string","got":"number"}],"finalText":"text"}"#
        );
    }

    #[test]
    fn mismatch_is_typed_and_absent_from_other_errors() {
        let error =
            WorkflowError::new(ErrorCode::ScriptHashMismatch, "changed").with_mismatch("a", "b");
        assert_eq!(
            error.to_json()["mismatch"],
            json!({"expected": "a", "got": "b"})
        );
        let plain = WorkflowError::new(ErrorCode::DriverError, "boom").to_json();
        assert!(plain.get("mismatch").is_none());
        assert!(plain.get("providerStop").is_none());
    }

    #[test]
    fn unknown_codes_do_not_parse() {
        assert_eq!(ErrorCode::parse("Bogus"), None);
    }
}
