//! Fork (slice 3 layer B): the run's ticket source, Node `OffPeakTicketAuthority` over the lifecycle.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::off_peak_ticket::OffPeakTicketSource;
use serde_json::{Value, json};

use crate::off_peak_control::OffPeakRuns;
use crate::off_peak_ticket::{LifecycleSink, RunTickets};

const PROVIDER: &str = "account:zai-offpeak-idle-plan";

fn runs_with_run() -> Arc<OffPeakRuns> {
    let runs = Arc::new(OffPeakRuns::default());
    runs.start("sess_1", "exe_1", "oft_1", "tkt_1", PROVIDER, "3105")
        .unwrap();
    runs
}

/// A sink that keeps what the run reports, in order, and delivers all of it.
type Sent = Arc<Mutex<Vec<Value>>>;

struct Keep(Sent);

#[async_trait]
impl LifecycleSink for Keep {
    async fn send(&self, note: &Value) -> bool {
        self.0.lock().unwrap().push(note.clone());
        true
    }
}

/// A sink whose connection is closed: nothing is delivered.
struct Closed;

#[async_trait]
impl LifecycleSink for Closed {
    async fn send(&self, _note: &Value) -> bool {
        false
    }
}

fn sink() -> (Sent, Arc<dyn LifecycleSink>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    (sent.clone(), Arc::new(Keep(sent)))
}

fn tickets(runs: &Arc<OffPeakRuns>, sink: Arc<dyn LifecycleSink>) -> RunTickets {
    RunTickets::new(runs.clone(), "sess_1", "exe_1", sink)
}

/// A refusal carrying the provider's business code.
fn coded(code: &str) -> ModelError {
    ModelError::Provider {
        provider: Box::new(
            serde_json::from_value(json!({"code": code, "status": null, "retryable": false}))
                .unwrap(),
        ),
        error: Box::new(ModelError::Authentication {
            message: "x".to_owned(),
        }),
    }
}

fn replace(runs: &OffPeakRuns, renewal: u64, ticket: &str, auth: Value) {
    let control = runs.control(
        "sess_1",
        &json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "replace_ticket",
            "renewalId": renewal, "ticketId": ticket, "requestAuth": auth}),
    );
    assert!(control.accepted);
}

/// Waits until `done` holds, yielding to the runtime between checks instead of sleeping for a fixed time.
async fn until(mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the condition holds");
}

#[tokio::test]
async fn a_ready_run_hands_out_its_start_ticket_with_no_credentials_of_its_own() {
    let runs = runs_with_run();
    let (_sent, sink) = sink();
    let ticket = tickets(&runs, sink).acquire().await.unwrap();
    assert_eq!(ticket.id, "tkt_1");
    assert_eq!(ticket.auth, None, "the ordinary source supplies them");
}

/// Node `retryExpired`: a refusal of this run's expired code, from its own provider, is the refusal to renew.
#[test]
fn only_the_run_s_provider_and_the_expired_codes_refuse_as_expired() {
    let runs = runs_with_run();
    let (_sent, sink) = sink();
    let source = tickets(&runs, sink);
    let expired = coded("3102");
    assert!(source.refused_as_expired(PROVIDER, &expired));
    assert!(
        !source.refused_as_expired("other", &expired),
        "another provider"
    );
    // The run's own provider code counts as expired (Node `providerErrorCode`); an unrelated code does not.
    let unrelated = coded("9999");
    assert!(
        !source.refused_as_expired(PROVIDER, &unrelated),
        "an unrelated code"
    );
}

/// Node `ticketExpired` then `waitForTicket`: the expired attempt waits for the Host's renewal, then the next acquire
/// returns the renewed ticket with the credentials the Host sent for it.
#[tokio::test]
async fn an_expired_ticket_waits_for_the_renewal_and_then_uses_the_renewed_credentials() {
    let runs = runs_with_run();
    let (sent, sink) = sink();
    let source = Arc::new(tickets(&runs, sink));
    let expiring = {
        let source = source.clone();
        tokio::spawn(async move { source.expired("tkt_1").await })
    };
    // The renewal is asked for: the Host gets a `ticket_needed` notification.
    until(|| {
        sent.lock()
            .unwrap()
            .iter()
            .any(|note| note["type"] == "ticket_needed")
    })
    .await;
    assert!(!expiring.is_finished(), "waits for the renewal");
    replace(
        &runs,
        1,
        "tkt_2",
        json!({"apiKey": "sk-2", "headers": {"x-sign": "s"}}),
    );
    expiring.await.unwrap().unwrap();
    let ticket = source.acquire().await.unwrap();
    assert_eq!(ticket.id, "tkt_2");
    let auth = ticket.auth.unwrap();
    assert_eq!(auth.api_key.unwrap().expose(), "sk-2");
    assert_eq!(auth.headers[0].0, "x-sign");
}

/// An attempt on a ticket that was already replaced retries at once on the current one (Node `retryExpired`).
#[tokio::test]
async fn a_stale_refusal_retries_at_once_on_the_current_ticket() {
    let runs = runs_with_run();
    let (_sent, sink) = sink();
    let source = tickets(&runs, sink);
    let _ = runs.expire_ticket("sess_1", "exe_1", "tkt_1");
    replace(&runs, 1, "tkt_2", Value::Null);
    source.expired("tkt_1").await.unwrap();
    assert_eq!(source.acquire().await.unwrap().id, "tkt_2");
}

/// A cancelled run fails the waiting attempts with a cancellation, and so does a later acquire. The Node code is the
/// run's state, not a rejected credential, so it must not surface as an authentication failure.
#[tokio::test]
async fn a_cancelled_run_ends_its_attempts() {
    let runs = runs_with_run();
    let (_sent, sink) = sink();
    let source = Arc::new(tickets(&runs, sink));
    let _ = runs.expire_ticket("sess_1", "exe_1", "tkt_1");
    let waiting = {
        let source = source.clone();
        tokio::spawn(async move { source.expired("tkt_1").await })
    };
    let _ = runs.control(
        "sess_1",
        &json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"}),
    );
    let error = waiting.await.unwrap().unwrap_err();
    assert!(
        matches!(error, ModelError::Cancelled),
        "a cancellation, not {error:?}"
    );
    assert!(source.acquire().await.is_err());
}

/// A renewal answered before the attempt starts waiting is not waited for: the waiter sees the state it was answered
/// into, so no wake-up is needed.
#[tokio::test]
async fn a_renewal_answered_before_the_wait_starts_is_not_waited_for() {
    let runs = runs_with_run();
    let (_sent, sink) = sink();
    let source = tickets(&runs, sink);
    let _ = runs.expire_ticket("sess_1", "exe_1", "tkt_1");
    replace(&runs, 1, "tkt_2", Value::Null);
    tokio::time::timeout(Duration::from_secs(5), source.expired("tkt_1"))
        .await
        .expect("not waiting for a renewal already answered")
        .unwrap();
}

/// A renewal request that cannot be delivered (the connection is closed) ends the run, so its expired attempt ends too:
/// nobody will answer that request, so the attempt must not wait for it.
#[tokio::test]
async fn an_undelivered_renewal_request_ends_the_run_instead_of_waiting() {
    let runs = runs_with_run();
    let source = tickets(&runs, Arc::new(Closed));
    let outcome = tokio::time::timeout(Duration::from_secs(5), source.expired("tkt_1"))
        .await
        .expect("the attempt must not wait for a renewal nobody was asked for");
    assert!(outcome.is_err());
    assert!(source.acquire().await.is_err(), "the run has ended");
}

/// The renewal request is sent even when its attempt is dropped right after asking for it (its turn ends): the request
/// is the only trigger of the Host's renewal, so it must not depend on the attempt's future staying alive.
#[tokio::test]
async fn a_renewal_request_is_sent_even_when_its_attempt_is_dropped() {
    use futures_util::FutureExt;
    let runs = runs_with_run();
    let (sent, sink) = sink();
    let source = tickets(&runs, sink);
    // One poll asks for the renewal; the attempt is then dropped.
    let _ = source.expired("tkt_1").now_or_never();
    until(|| {
        sent.lock()
            .unwrap()
            .iter()
            .any(|note| note["type"] == "ticket_needed")
    })
    .await;
}
