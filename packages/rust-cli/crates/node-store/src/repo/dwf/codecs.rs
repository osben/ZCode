//! Node's dwf_* row codecs (`adapters/.../repositories/dwf-journal-codecs.ts`), ported 1:1.
//!
//! The physical `dwf_run.status` column keeps its five legacy values (`failed`, `cancelled`), and the
//! logical vocabulary (`errored`, `stopped`) is encoded in `failure_json`:
//!
//! | logical                  | physical    | failure_json                                          |
//! | ------------------------ | ----------- | ----------------------------------------------------- |
//! | stopped { reason, ... }  | cancelled   | `{"stopReason": …, "supersededBy"?: …, "error"?: …}`  |
//! | errored { failure }      | failed      | the failure as is                                     |
//! | completed                | completed   | the failure as is (normally NULL)                     |
//! | pending / running        | same        | NULL                                                  |
//!
//! Decoding is total. `cancelled` without a usable envelope is `stopped(user)`. `failed` with code
//! `Interrupted` is `stopped(interrupted)`. Other `failed` rows are `errored`.
use serde_json::{Map, Value};

use super::{RunStatus, Settlement, StopReason};

const INTERRUPTED_CODE: &str = "Interrupted";

/// The physical vocabulary of `dwf_run.status` (the CHECK set in migration 0019).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl PhysicalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_column(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

/// Physical column values for one logical settlement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub status: PhysicalStatus,
    pub failure_json: Option<String>,
}

/// The logical terminal-state tuple read back from a row.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSettlementFields {
    pub status: RunStatus,
    pub stop_reason: Option<StopReason>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
}

pub fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::User => "user",
        StopReason::Model => "model",
        StopReason::Provider => "provider",
        StopReason::Interrupted => "interrupted",
        StopReason::Superseded => "superseded",
    }
}

fn parse_stop_reason(name: &str) -> Option<StopReason> {
    Some(match name {
        "user" => StopReason::User,
        "model" => StopReason::Model,
        "provider" => StopReason::Provider,
        "interrupted" => StopReason::Interrupted,
        "superseded" => StopReason::Superseded,
        _ => return None,
    })
}

/// Node `encodeJson`: `undefined` and `null` are SQL NULL.
pub fn encode_json(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.to_string()),
    }
}

/// Node `encodeResultJson`: only a missing result is SQL NULL, so a stored `null` survives.
pub fn encode_result_json(value: Option<&Value>) -> Option<String> {
    value.map(Value::to_string)
}

/// Node `decodeJson`: NULL and JSON `null` are absent. Unparsable text is absent too (Node would throw).
pub fn decode_json(text: Option<&str>) -> Option<Value> {
    match serde_json::from_str::<Value>(text?) {
        Ok(Value::Null) | Err(_) => None,
        Ok(value) => Some(value),
    }
}

/// Logical status and settlement to the physical column values (Node `encodeRunSettlement`).
pub fn encode_run_settlement(status: RunStatus, settlement: &Settlement) -> Encoded {
    match status {
        RunStatus::Stopped => {
            let mut envelope = Map::new();
            let reason = settlement.stop_reason.unwrap_or(StopReason::User);
            envelope.insert(
                "stopReason".into(),
                Value::String(stop_reason_name(reason).into()),
            );
            if let Some(superseded_by) = &settlement.superseded_by {
                envelope.insert("supersededBy".into(), Value::String(superseded_by.clone()));
            }
            if let Some(error) = &settlement.failure {
                envelope.insert("error".into(), error.clone());
            }
            Encoded {
                status: PhysicalStatus::Cancelled,
                failure_json: Some(Value::Object(envelope).to_string()),
            }
        }
        RunStatus::Errored => Encoded {
            status: PhysicalStatus::Failed,
            failure_json: encode_json(settlement.failure.as_ref()),
        },
        RunStatus::Completed => Encoded {
            status: PhysicalStatus::Completed,
            failure_json: encode_json(settlement.failure.as_ref()),
        },
        RunStatus::Pending => Encoded {
            status: PhysicalStatus::Pending,
            failure_json: None,
        },
        RunStatus::Running => Encoded {
            status: PhysicalStatus::Running,
            failure_json: None,
        },
    }
}

/// Physical column values to the logical tuple (Node `decodeRunSettlement`).
pub fn decode_run_settlement(
    status: PhysicalStatus,
    failure_json: Option<&str>,
) -> RunSettlementFields {
    let raw = decode_json(failure_json);
    let plain = |status: RunStatus, failure: Option<Value>| RunSettlementFields {
        status,
        stop_reason: None,
        superseded_by: None,
        failure,
    };
    match status {
        PhysicalStatus::Cancelled => {
            let mut fields = RunSettlementFields {
                status: RunStatus::Stopped,
                stop_reason: Some(StopReason::User),
                superseded_by: None,
                failure: None,
            };
            // The reason is the allowlist: an unknown name keeps the default, as in Node's STOP_REASONS.
            let envelope = raw.as_ref().and_then(Value::as_object);
            let reason = envelope
                .and_then(|envelope| envelope.get("stopReason"))
                .and_then(Value::as_str)
                .and_then(parse_stop_reason);
            if let (Some(envelope), Some(reason)) = (envelope, reason) {
                fields.stop_reason = Some(reason);
                if let Some(superseded_by) = envelope
                    .get("supersededBy")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    fields.superseded_by = Some(superseded_by.to_owned());
                }
                fields.failure = envelope.get("error").cloned();
            }
            fields
        }
        PhysicalStatus::Failed => {
            let interrupted = raw
                .as_ref()
                .and_then(|failure| failure.get("code"))
                .and_then(Value::as_str)
                == Some(INTERRUPTED_CODE);
            if interrupted {
                RunSettlementFields {
                    status: RunStatus::Stopped,
                    stop_reason: Some(StopReason::Interrupted),
                    superseded_by: None,
                    failure: raw,
                }
            } else {
                plain(RunStatus::Errored, raw)
            }
        }
        PhysicalStatus::Completed => plain(RunStatus::Completed, raw),
        PhysicalStatus::Pending => plain(RunStatus::Pending, None),
        PhysicalStatus::Running => plain(RunStatus::Running, None),
    }
}
