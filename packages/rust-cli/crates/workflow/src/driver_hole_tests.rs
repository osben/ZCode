//! The owner's hole reach and fill (W7-12, spec 9.45): a reach parks its branch and journals `hole-reached`; a fill
//! releases it with the code and journals `hole-filled`; a later reach of the filled site is answered from the fill.
use crate::driver_feed_tests::{count_of, new_owner, start_ask};
use crate::engine_holes::{FillHoleResult, HoleFill};
use serde_json::json;
use std::collections::HashMap;

/// A fill with the tables a fill hands the engine, and no body beyond the code.
fn fill_for(site: &str, code: &str) -> HoleFill {
    HoleFill {
        site_id: site.to_owned(),
        code: code.to_owned(),
        script_text: "effective script".to_owned(),
        script_hash: "hash-of-effective".to_owned(),
        ask_specs: HashMap::new(),
        site_phases: HashMap::new(),
        phase_names: Vec::new(),
        holes: None,
        filled_by: None,
        script_path: None,
    }
}

/// Through the mailbox: a hole call's reply waits for the fill that the handle posts; the fill is served on the owner.
#[test]
fn a_mailbox_hole_is_answered_by_a_fill_through_the_handle() {
    use crate::actor_mailbox::{ActorHandle, ActorMailbox, TicketedCall};
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    let (mailbox, handle) = ActorMailbox::new();
    let answer = handle
        .send_ticketed(TicketedCall::Hole {
            site_id: "hole#1".to_owned(),
            name: "decide".to_owned(),
            prompt: None,
        })
        .expect("the hole call is sent");
    mailbox.serve_next(&mut owner).expect("serve the hole");
    assert_eq!(count_of(&owner, "hole-reached"), 1);
    let fill = std::thread::spawn(move || handle.fill_hole(fill_for("hole#1", "return 5;")));
    mailbox.serve_next(&mut owner).expect("serve the fill");
    let filled = fill
        .join()
        .expect("the fill thread")
        .expect("the fill is answered");
    assert_eq!(filled, FillHoleResult::Filled);
    let settled = ActorHandle::await_ticketed(answer).expect("the parked call is answered");
    assert!(
        matches!(&settled, Ok(value) if value == &json!({"code": "return 5;"})),
        "the parked call receives the fill's code"
    );
}

/// A reach with no body parks its branch, journals `hole-reached` with the prompt, and settles nothing yet.
#[test]
fn a_hole_parks_its_branch_and_journals_hole_reached() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner
        .hole("hole#1", "decide", Some("pick one"))
        .expect("the hole is reached");
    assert_eq!(count_of(&owner, "hole-reached"), 1);
    assert!(
        owner.take_outcomes().is_empty(),
        "the branch waits for its fill"
    );
}

/// A fill releases the parked branch with `{code}`, and journals `hole-filled`.
#[test]
fn a_fill_releases_the_parked_branch_with_its_code_and_journals_hole_filled() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner
        .hole("hole#1", "decide", None)
        .expect("the hole is reached");
    let filled = owner
        .fill_hole(fill_for("hole#1", "return 1;"))
        .expect("the fill");
    assert_eq!(filled, FillHoleResult::Filled);
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1, "the parked branch is released once");
    assert!(
        matches!(&outcomes[0].result, Ok(value) if value == &json!({"code": "return 1;"})),
        "the branch receives the fill's code"
    );
    assert_eq!(count_of(&owner, "hole-filled"), 1);
}

/// A second reach of a site this lifetime already filled is answered at once, with no new `hole-reached`.
#[test]
fn a_second_reach_of_a_filled_site_is_answered_from_the_fill() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner.hole("hole#1", "decide", None).expect("reached");
    owner
        .fill_hole(fill_for("hole#1", "return 2;"))
        .expect("the fill");
    let _ = owner.take_outcomes();
    owner.hole("hole#1", "decide", None).expect("reached again");
    assert_eq!(count_of(&owner, "hole-reached"), 1, "no second park");
    let outcomes = owner.take_outcomes();
    assert!(
        matches!(outcomes.as_slice(), [outcome] if matches!(&outcome.result, Ok(value) if value == &json!({"code": "return 2;"}))),
        "the second reach is answered from the fill"
    );
}

/// A fill for a site nobody waits on changes nothing.
#[test]
fn a_fill_for_a_site_nobody_waits_on_is_not_waiting() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    let result = owner
        .fill_hole(fill_for("hole#9", "return 3;"))
        .expect("the fill");
    assert_eq!(result, FillHoleResult::NotWaiting);
    assert_eq!(count_of(&owner, "hole-filled"), 0);
}

/// A fill after the run settled is refused as settled, and nothing is journaled.
#[test]
fn a_fill_after_settlement_is_refused_as_settled() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner.hole("hole#1", "decide", None).expect("reached");
    owner.stop_interrupted().expect("stopped");
    let result = owner
        .fill_hole(fill_for("hole#1", "return 4;"))
        .expect("the fill");
    assert_eq!(result, FillHoleResult::Settled);
    assert_eq!(count_of(&owner, "hole-filled"), 0);
}
