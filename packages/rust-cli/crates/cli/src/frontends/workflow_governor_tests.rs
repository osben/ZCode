//! The governor adapter's mapping and its port calls (W7-3). The reason strings are Node's `ConcurrencyChangeReason`
//! values (`apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts`).
use super::*;
use rust_cli_model::governor::controller::Change;
use rust_cli_model::governor::scheduler;
use std::sync::Mutex;

#[test]
fn every_controller_reason_has_nodes_string() {
    assert_eq!(wire_reason(ChangeReason::RateLimited), "rate_limited");
    assert_eq!(wire_reason(ChangeReason::Overloaded), "provider_overloaded");
    assert_eq!(wire_reason(ChangeReason::Recovered), "recovered");
    assert_eq!(wire_reason(ChangeReason::IdleReset), "idle_reset");
    assert_eq!(wire_reason(ChangeReason::LimitLowered), "limit_lowered");
    assert_eq!(wire_reason(ChangeReason::Seeded), "seeded");
}

#[test]
fn a_change_keeps_its_fields_and_takes_the_reason_string() {
    let change = CapChange {
        key: "openai/gpt-x".to_owned(),
        change: Change {
            previous: 8,
            next: 4,
            reason: ChangeReason::RateLimited,
            last_good: Some(8),
            last_bad: None,
            cooldown_ms: Some(1_500),
        },
    };
    assert_eq!(
        run_change(&change),
        ConcurrencyChange {
            key: "openai/gpt-x".to_owned(),
            previous: 8,
            next: 4,
            reason: "rate_limited".to_owned(),
            last_good: Some(8),
            last_bad: None,
            cooldown_ms: Some(1_500),
        }
    );
}

#[test]
fn a_run_bound_is_at_least_one_and_saturates() {
    assert_eq!(governor_bound(0), 1);
    assert_eq!(governor_bound(40), 40);
    assert_eq!(governor_bound(u64::MAX), u32::MAX);
}

fn governor() -> Arc<Governor> {
    let clock: Arc<dyn rust_cli_kernel_api::clock::Clock> =
        Arc::new(rust_cli_base::clock::SystemClock::utc());
    Governor::new(clock, 4, scheduler())
}

#[test]
fn a_subscribed_run_hears_a_retune_and_nothing_after_it_unsubscribes() {
    let gov = governor();
    let port = GovernorRunConcurrency::new(gov.clone());
    // The run engages the key by admitting a request on it: the governor fans changes out to engaged runs only.
    let _ticket = gov
        .try_admit(
            &rust_cli_model::admission::AdmissionScope::Run(RunId::new("wf_1")),
            "openai/gpt-x",
        )
        .expect("the run is admitted");
    let heard: Arc<Mutex<Vec<ConcurrencyChange>>> = Arc::default();
    let sink = heard.clone();
    let end = port.subscribe(
        "wf_1",
        Box::new(move |change: &ConcurrencyChange| {
            sink.lock().expect("heard").push(change.clone());
        }),
    );
    // Raising the run's bound seeds the engaged key's cap from 4 to 12, a change the run hears.
    port.set_run_bound("wf_1", 12);
    {
        let changes = heard.lock().expect("heard");
        assert_eq!(changes.len(), 1, "the retune is delivered: {changes:?}");
        assert_eq!(changes[0].reason, "seeded");
        assert_eq!(changes[0].key, "openai/gpt-x");
        assert_eq!(changes[0].next, 12);
    }
    end();
    port.set_run_bound("wf_1", 16);
    assert_eq!(
        heard.lock().expect("heard").len(),
        1,
        "no change is delivered after the unsubscribe"
    );
}
