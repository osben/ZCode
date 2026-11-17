//! Fork (slice 3 layer B): the run's ticket source, Node `OffPeakTicketAuthority` over the lifecycle.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::off_peak_ticket::OffPeakTicketSource;
use serde_json::{Value, json};

use crate::off_peak_control::OffPeakRuns;
use crate::off_peak_ticket::RunTickets;

const PROVIDER: &str = "account:zai-offpeak-idle-plan";

fn runs_with_run() -> Arc<OffPeakRuns> {
    let runs = Arc::new(OffPeakRuns::default());
    runs.start("sess_1", "exe_1", "oft_1", "tkt_1", PROVIDER, "3105")
        .unwrap();
    runs
}

/// A sink that keeps what the run reports, in order.
type Sent = Arc<Mutex<Vec<Value>>>;
type Sink = Arc<dyn Fn(&Value) + Send + Sync>;

fn sink() -> (Sent, Sink) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let kept = sent.clone();
    (
        sent,
        Arc::new(move |value: &Value| kept.lock().unwrap().push(value.clone())),
    )
}

fn tickets(runs: &Arc<OffPeakRuns>, sink: Arc<dyn Fn(&Value) + Send + Sync>) -> RunTickets {
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
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        sent.lock()
            .unwrap()
            .iter()
            .any(|note| note["type"] == "ticket_needed")
    );
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

/// A cancelled run fails the waiting attempts with the Node code, and so does a later acquire.
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
    tokio::time::sleep(Duration::from_millis(20)).await;
    let _ = runs.control(
        "sess_1",
        &json!({"sessionId": "sess_1", "executionId": "exe_1", "action": "cancel"}),
    );
    let error = waiting.await.unwrap().unwrap_err();
    assert!(
        matches!(error, ModelError::Authentication { ref message } if message == "off_peak_cancelled")
    );
    assert!(source.acquire().await.is_err());
}
