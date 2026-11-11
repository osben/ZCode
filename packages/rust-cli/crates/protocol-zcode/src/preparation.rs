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
use rust_cli_kernel_api::incognito::IncognitoProfile;
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

/// The session's marker. A failed read is an error, not "no marker": a reservation that read it as absent could create
/// over a reservation it could not see. The text names no storage detail.
pub async fn load(server: &Server, session: &SessionId) -> Result<Option<Marker>, &'static str> {
    let records = server
        .kernel
        .queries()
        .records(session, KIND)
        .await
        .map_err(|_| "reading the submission reservation failed")?;
    Ok(Marker::latest(&records))
}

/// Serializes reservations: the existence check, the create and the marker save of one reservation run under one permit,
/// so two reservations of the same new id cannot both find it absent. A semaphore, not a Mutex: the lint policy forbids
/// holding a tokio MutexGuard across an await.
pub(crate) struct ReservationGate(tokio::sync::Semaphore);

impl Default for ReservationGate {
    fn default() -> Self {
        Self(tokio::sync::Semaphore::new(1))
    }
}

impl ReservationGate {
    pub(crate) async fn acquire(&self) -> Result<tokio::sync::SemaphorePermit<'_>, &'static str> {
        self.0
            .acquire()
            .await
            .map_err(|_| "the reservation gate is closed")
    }
}

/// Only "no such session" makes a session id free. Any other snapshot error propagates: reading it as absent would let a
/// reservation create over a session that exists.
pub(crate) fn absent_if_not_found<T>(
    result: Result<T, rust_cli_kernel_api::session_api::KernelError>,
) -> Result<Option<T>, rust_cli_kernel_api::session_api::KernelError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rust_cli_kernel_api::session_api::KernelError::NotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Fork: whether `session` has a soft-deleted row. A deleted session reads as "no such session", but its row still
/// exists: Node's createSession reads `getSession` (deleted rows included) and refuses before any write, while a
/// create here would upsert over the row (title, directory, and possibly the incognito profile) before failing. A
/// store without the row read cannot hold one.
pub(crate) async fn deleted(server: &Server, session: &SessionId) -> Result<bool, &'static str> {
    match server.kernel.queries().reconcile_row(session).await {
        Ok(row) => Ok(row_deleted(row.as_ref())),
        Err(rust_cli_kernel_api::store::StoreError::Unsupported { .. }) => Ok(false),
        // No error text: a storage error can name the storage path.
        Err(_) => Err("reading the session failed"),
    }
}

/// Fork: a reconcile row (`StoreQueries::reconcile_row`) with a deletion time.
pub(crate) fn row_deleted(row: Option<&Value>) -> bool {
    row.and_then(|row| row.get("timeDeleted"))
        .is_some_and(|time| !time.is_null())
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

/// The incognito profiles of a reservation: the one stored on the existing row and the requested one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct ReserveIncognito {
    pub(crate) stored: Option<IncognitoProfile>,
    pub(crate) requested: Option<IncognitoProfile>,
}

/// Fork: whether an existing session has a conversation (messages, queued input or a running turn). With no
/// submission marker and the same workspace, a session without one is an untouched prewarm: the one rule for a
/// reservation's adoption ([`reserve_existing`]) and a plain createSession's repeat ([`recreate_existing`]).
pub(crate) fn has_conversation(view: &rust_cli_kernel_api::session_api::SessionView) -> bool {
    !view.messages.is_empty() || !view.queue.is_empty() || view.running
}

/// Fork: whether a plain createSession may repeat an id that already exists. Node refuses every existing id
/// ("sessionId already exists") because it keeps a prewarm deferred. In zcode-rs a prewarm can still be visible here
/// (an open draft, or a row persisted before draft deferral), so only an untouched prewarm in the same workspace under
/// the same profile (absent differs from present) is repeated. Any other session is refused: a repeat would reset its
/// runtime state and run it with a profile its row does not hold. The store never refuses; this is the one rule.
pub(crate) fn recreate_existing(
    marker: Option<&Marker>,
    workspace_matches: bool,
    conversation: bool,
    incognito: ReserveIncognito,
) -> Result<(), &'static str> {
    if !workspace_matches {
        return Err("it belongs to another workspace");
    }
    if marker.is_some() {
        return Err("a submission reserved it");
    }
    if conversation {
        return Err("it already has a conversation");
    }
    if incognito.stored != incognito.requested {
        return Err("it has another incognito profile");
    }
    Ok(())
}

pub(crate) fn reserve_existing(
    marker: Option<&Marker>,
    submission: &str,
    workspace_matches: bool,
    conversation: bool,
    incognito: ReserveIncognito,
) -> Reserve {
    if !workspace_matches {
        return Reserve::Refuse("it belongs to another workspace");
    }
    match marker {
        // Fork: a repeat must carry the profile the row was reserved with (Node `incognitoProfilesEqual`).
        Some(marker) if marker.submission_id == submission => {
            if incognito.stored == incognito.requested {
                Reserve::Repeat
            } else {
                Reserve::Refuse("another incognito profile reserved it")
            }
        }
        Some(_) => Reserve::Refuse("another submission reserved it"),
        None if conversation => Reserve::Refuse("it already has a conversation"),
        // Fork: a prewarm is a normal session; it is never adopted for, or as, an incognito one (Node refuses
        // "an incompatible prewarm").
        None if incognito.stored.is_some() || incognito.requested.is_some() => {
            Reserve::Refuse("an incognito reservation cannot reuse a prewarm")
        }
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
    #[tokio::test]
    async fn two_reservations_of_one_new_id_cannot_both_create_it() {
        // Finding: check, create and save were not serialized, so both reservations saw the id as absent. The
        // store stands in for the kernel; the await between check and create is where the race opened.
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        let gate = Arc::new(ReservationGate::default());
        let store = Arc::new(Mutex::new(HashMap::<&str, &str>::new()));
        let reserve = |submission: &'static str| {
            let (gate, store) = (gate.clone(), store.clone());
            async move {
                let _permit = gate.acquire().await.unwrap();
                let absent = !store.lock().unwrap().contains_key("s1");
                tokio::task::yield_now().await;
                if absent {
                    store.lock().unwrap().insert("s1", submission);
                }
                absent
            }
        };
        let (first, second) = tokio::join!(reserve("sub-1"), reserve("sub-2"));
        assert!(
            first ^ second,
            "exactly one reservation may create the session"
        );
    }

    #[test]
    fn only_not_found_makes_a_session_id_free() {
        use rust_cli_kernel_api::session_api::KernelError;
        assert_eq!(absent_if_not_found(Ok(7)).unwrap(), Some(7));
        let missing = KernelError::NotFound {
            session: SessionId::new("s1"),
        };
        assert_eq!(absent_if_not_found::<u8>(Err(missing)).unwrap(), None);
        let failed = KernelError::Failed {
            message: "disk unavailable".into(),
        };
        assert!(absent_if_not_found::<u8>(Err(failed)).is_err());
    }

    #[test]
    fn adopts_only_an_untouched_prewarm_in_the_same_workspace() {
        let marker = Marker::preparing("sub-1", 1);
        assert_eq!(
            reserve_existing(None, "sub-1", true, false, normal()),
            Reserve::Adopt
        );
        assert_eq!(
            reserve_existing(Some(&marker), "sub-1", true, false, normal()),
            Reserve::Repeat
        );
        assert!(matches!(
            reserve_existing(Some(&marker), "sub-2", true, false, normal()),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(None, "sub-1", true, true, normal()),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(None, "sub-1", false, false, normal()),
            Reserve::Refuse(_)
        ));
        assert!(matches!(
            reserve_existing(Some(&marker), "sub-1", false, false, normal()),
            Reserve::Refuse(_)
        ));
    }

    #[test]
    fn a_plain_create_repeats_only_an_untouched_prewarm_under_the_same_profile() {
        let marker = Marker::preparing("sub-1", 1);
        let lockdown = Some(IncognitoProfile::LOCKDOWN);
        let softer = Some(IncognitoProfile {
            mcp: true,
            ..IncognitoProfile::LOCKDOWN
        });
        let same = |profile| ReserveIncognito {
            stored: profile,
            requested: profile,
        };
        assert_eq!(recreate_existing(None, true, false, normal()), Ok(()));
        assert_eq!(recreate_existing(None, true, false, same(lockdown)), Ok(()));
        // A session with history, queued input or a running turn is never re-created (Node "sessionId already exists").
        assert!(recreate_existing(None, true, true, normal()).is_err());
        assert!(recreate_existing(None, true, true, same(lockdown)).is_err());
        assert!(recreate_existing(Some(&marker), true, false, normal()).is_err());
        assert!(recreate_existing(None, false, false, normal()).is_err());
        for (stored, requested) in [(lockdown, softer), (lockdown, None), (None, lockdown)] {
            let incognito = ReserveIncognito { stored, requested };
            assert!(recreate_existing(None, true, false, incognito).is_err());
        }
    }

    #[test]
    fn only_a_row_with_a_deletion_time_is_deleted() {
        assert!(!row_deleted(None));
        assert!(!row_deleted(Some(
            &json!({"timeDeleted": null, "title": "t"})
        )));
        assert!(!row_deleted(Some(&json!({"title": "t"}))));
        assert!(row_deleted(Some(&json!({"timeDeleted": 4_000}))));
    }

    fn normal() -> ReserveIncognito {
        ReserveIncognito::default()
    }

    #[test]
    fn an_incognito_reservation_repeats_only_with_the_same_profile_and_never_adopts() {
        let marker = Marker::preparing("sub-1", 1);
        let lockdown = Some(IncognitoProfile::LOCKDOWN);
        let other = Some(IncognitoProfile {
            mcp: true,
            ..IncognitoProfile::LOCKDOWN
        });
        let same = ReserveIncognito {
            stored: lockdown,
            requested: lockdown,
        };
        assert_eq!(
            reserve_existing(Some(&marker), "sub-1", true, false, same),
            Reserve::Repeat
        );
        for (stored, requested) in [(lockdown, other), (lockdown, None), (None, lockdown)] {
            let incognito = ReserveIncognito { stored, requested };
            assert!(matches!(
                reserve_existing(Some(&marker), "sub-1", true, false, incognito),
                Reserve::Refuse(_)
            ));
            assert!(matches!(
                reserve_existing(None, "sub-1", true, false, incognito),
                Reserve::Refuse(_)
            ));
        }
    }
}
