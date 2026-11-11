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
