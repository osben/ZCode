//! The off-peak lifecycle: state, ticket renewal, takeover, cancel and completion (Node `off-peak/lifecycle.ts`).
use super::*;

fn idle() -> WorkSnapshot {
    WorkSnapshot::default()
}

fn running() -> WorkSnapshot {
    WorkSnapshot {
        main_running: true,
        ..WorkSnapshot::default()
    }
}

fn background() -> WorkSnapshot {
    WorkSnapshot {
        background_running: true,
        ..WorkSnapshot::default()
    }
}

#[test]
fn the_state_follows_the_work_and_completes_when_nothing_is_left() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    assert_eq!(life.state(), State::RunningIdle);
    life.work_changed(running());
    assert_eq!(life.state(), State::RunningIdle);
    life.main_ended(Outcome::Succeeded);
    life.work_changed(background());
    assert_eq!(life.state(), State::WaitingBackground);
    life.work_changed(idle());
    assert!(life.terminal());
    assert_eq!(
        life.drain_events(),
        vec![
            Event::StateChanged(State::WaitingBackground),
            Event::StateChanged(State::Completed),
            // Node `releaseUnusedTicket` runs on completion too.
            Event::TicketReleased {
                ticket_id: "tkt_1".to_owned()
            },
            Event::Completed {
                outcome: Outcome::Succeeded
            },
        ]
    );
}

#[test]
fn an_expired_ticket_asks_once_and_the_renewal_id_is_stable() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    let renewal = life.ticket_expired("tkt_1").expect("a renewal");
    assert_eq!(life.state(), State::WaitingTicket);
    assert_eq!(life.ticket_expired("tkt_1"), Some(renewal));
    assert_eq!(
        life.drain_events(),
        vec![
            Event::StateChanged(State::WaitingTicket),
            Event::TicketNeeded {
                renewal_id: renewal,
                expired_ticket_id: "tkt_1".to_owned(),
            },
        ]
    );
    // A ticket that is not the current one is not renewed.
    assert_eq!(life.ticket_expired("old"), None);
}

#[test]
fn replacing_the_ticket_releases_the_old_one_and_is_idempotent() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    let renewal = life.ticket_expired("tkt_1").unwrap();
    life.drain_events();
    assert!(life.replace_ticket(renewal, "tkt_2"));
    assert_eq!(life.state(), State::RunningIdle);
    assert_eq!(life.ticket_id(), Some("tkt_2"));
    assert_eq!(
        life.drain_events(),
        vec![
            Event::TicketReleased {
                ticket_id: "tkt_1".to_owned()
            },
            Event::StateChanged(State::RunningIdle),
        ]
    );
    // The same answer again (a lost reply) is accepted without another effect.
    assert!(life.replace_ticket(renewal, "tkt_2"));
    assert!(life.drain_events().is_empty());
}

#[test]
fn a_stale_or_unknown_renewal_is_refused() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    let renewal = life.ticket_expired("tkt_1").unwrap();
    assert!(!life.replace_ticket(renewal + 1, "tkt_2"));
    assert!(!life.replace_ticket(renewal, "tkt_1"));
    assert_eq!(life.state(), State::WaitingTicket);
}

#[test]
fn a_takeover_hands_the_run_to_the_user_and_refuses_idle_rounds() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    life.drain_events();
    life.take_over();
    assert!(life.owned_by_user());
    assert_eq!(life.state(), State::RunningUser);
    assert!(!life.retain_idle_model_round(), "the user owns the run now");
    let events = life.drain_events();
    assert_eq!(events[0], Event::UserTakeover);
    assert!(events.contains(&Event::TicketReleased {
        ticket_id: "tkt_1".to_owned()
    }));
}

#[test]
fn an_idle_model_round_keeps_the_run_open_until_released() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    assert!(life.retain_idle_model_round());
    life.main_ended(Outcome::Failed);
    life.work_changed(idle());
    assert!(!life.terminal(), "a model round still holds the run");
    life.release_idle_model_round(idle());
    assert_eq!(life.outcome(), Outcome::Failed);
    assert!(life.terminal());
}

#[test]
fn cancel_stops_the_run_once_and_refuses_later_renewals() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(running());
    life.drain_events();
    life.cancel();
    life.cancel();
    assert_eq!(life.state(), State::Cancelled);
    assert!(life.terminal());
    assert_eq!(life.ticket_expired("tkt_1"), None);
    assert!(!life.replace_ticket(1, "tkt_2"));
    let events = life.drain_events();
    assert_eq!(
        events,
        vec![
            Event::StateChanged(State::Cancelled),
            Event::TicketReleased {
                ticket_id: "tkt_1".to_owned()
            },
            Event::Completed {
                outcome: Outcome::Stopped
            },
        ]
    );
}

#[test]
fn a_completed_run_is_not_reopened_by_work() {
    let mut life = OffPeakLifecycle::new("tkt_1");
    life.work_changed(idle());
    assert!(life.terminal());
    life.work_changed(running());
    assert_eq!(life.state(), State::Completed);
}
