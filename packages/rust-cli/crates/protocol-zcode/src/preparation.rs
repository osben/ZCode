//! Fork: durable first submission (the desktop Host's `durableFirstSubmission` capability).
//!
//! A reservation `createSession` (`submissionPreparation`) creates the session and stores a marker; the activation
//! `createSession` (`preparedSessionId` + `expectedSubmissionId`) reports how far an earlier attempt got; the first
//! `sendText` (`firstSubmissionId`) flips the marker to active once the input is admitted.
//!
//! The marker uses the Node agent's record (`session_entry`, type `v4/fork_submission_preparation`,
//! data `{submissionId, status}`), so either runtime can read what the other one wrote. While the marker is
//! preparing, the conversation snapshot and the sessions-index row carry `submissionPreparation`.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::FrontendRecord;
use serde_json::{Value, json};

use crate::server::Server;

pub const KIND: &str = "v4/fork_submission_preparation";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub submission_id: String,
    pub active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

impl Marker {
    pub fn preparing(submission_id: &str, now: u64) -> Self {
        Self {
            submission_id: submission_id.to_owned(),
            active: false,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn activated(&self, now: u64) -> Self {
        Self {
            active: true,
            updated_at: now,
            ..self.clone()
        }
    }

    pub fn record(&self, session: &str) -> FrontendRecord {
        FrontendRecord {
            kind: KIND.to_owned(),
            key: format!("{KIND}:{session}"),
            data: json!({
                "submissionId": self.submission_id,
                "status": if self.active { "active" } else { "preparing" },
                "createdAt": self.created_at,
                "updatedAt": self.updated_at,
            }),
        }
    }

    /// The latest marker among the session's records (Node reads the last one too).
    pub fn latest(records: &[FrontendRecord]) -> Option<Self> {
        let data = &records.last()?.data;
        let submission_id = data["submissionId"].as_str()?;
        let active = match data["status"].as_str()? {
            "preparing" => false,
            "active" => true,
            _ => return None,
        };
        Some(Self {
            submission_id: submission_id.to_owned(),
            active,
            created_at: data["createdAt"].as_u64().unwrap_or_default(),
            updated_at: data["updatedAt"].as_u64().unwrap_or_default(),
        })
    }

    /// `submissionPreparation` for the snapshot meta and the sessions-index row; present only while preparing.
    pub fn exposed(&self) -> Option<Value> {
        (!self.active).then(|| {
            json!({
                "submissionId": self.submission_id,
                "status": "preparing",
                "createdAt": self.created_at,
                "updatedAt": self.updated_at,
            })
        })
    }
}

pub async fn load(server: &Server, session: &SessionId) -> Option<Marker> {
    let records = server.kernel.queries().records(session, KIND).await.ok()?;
    Marker::latest(&records)
}

pub async fn save(server: &Server, session: &SessionId, marker: &Marker) -> Result<(), String> {
    server
        .kernel
        .queries()
        .put_record(session, &marker.record(session.as_str()))
        .await
        .map_err(|error| error.to_string())
}

/// What a reservation does with a session id that already exists.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reserve {
    /// The same submission reserved it before (a retried reservation): answer with the same session.
    Repeat,
    /// An untouched prewarm. The UI prewarms the draft with a plain createSession before the first send and
    /// zcode-rs persists it at once, so it is adopted the way the Node agent adopts its deferred prewarm.
    Adopt,
    Refuse(&'static str),
}

pub(crate) fn reserve_existing(
    marker: Option<&Marker>,
    submission: &str,
    workspace_matches: bool,
    conversation: bool,
) -> Reserve {
    if !workspace_matches {
        return Reserve::Refuse("it belongs to another workspace");
    }
    match marker {
        Some(marker) if marker.submission_id == submission => Reserve::Repeat,
        Some(_) => Reserve::Refuse("another submission reserved it"),
        None if conversation => Reserve::Refuse("it already has a conversation"),
        None => Reserve::Adopt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_node_record_shape() {
        let marker = Marker::preparing("sub-1", 10);
        let record = marker.record("s1");
        assert_eq!(record.key, "v4/fork_submission_preparation:s1");
        assert_eq!(record.data["status"], "preparing");
        assert_eq!(Marker::latest(&[record]), Some(marker.clone()));
        assert_eq!(marker.exposed().unwrap()["submissionId"], "sub-1");
    }

    #[test]
    fn reads_a_node_written_marker_and_hides_an_active_one() {
        let node = FrontendRecord {
            kind: KIND.to_owned(),
            key: format!("{KIND}:s1"),
            data: json!({"submissionId": "sub-1", "status": "active"}),
        };
        let marker = Marker::latest(&[node]).unwrap();
        assert!(marker.active);
        assert_eq!(marker.exposed(), None);
        let broken = FrontendRecord {
            kind: KIND.to_owned(),
            key: "k".into(),
            data: json!({"status": "done"}),
        };
        assert_eq!(Marker::latest(&[broken]), None);
    }
    #[test]
    fn adopts_only_an_untouched_prewarm_in_the_same_workspace() {
        let marker = Marker::preparing("sub-1", 1);
        assert_eq!(reserve_existing(None, "sub-1", true, false), Reserve::Adopt);
        assert_eq!(
            reserve_existing(Some(&marker), "sub-1", true, false),
            Reserve::Repeat
        );
        assert!(matches!(
            reserve_existing(Some(&marker), "sub-2", true, false),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(None, "sub-1", true, true),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(None, "sub-1", false, false),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(Some(&marker), "sub-1", false, false),
            Reserve::Refuse(_)
        ));
    }
}
