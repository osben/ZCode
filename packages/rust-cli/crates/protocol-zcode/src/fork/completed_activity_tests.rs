//! Fork: `completedActivityCount` rules (specs/fork-rust-activity-summary.md; Node `00-tool-change-chain.md`,
//! "Activity 成功总数").

use super::*;

fn seeded(
    runs: &[(&str, &str, i64)],
    workflow_children: &[&str],
    children: &[(&str, &str)],
) -> CompletedActivity {
    let mut count = CompletedActivity::default();
    count.seed(Some(Seed {
        runs: runs
            .iter()
            .map(|(id, status, sequence)| ((*id).to_owned(), (*status).to_owned(), *sequence))
            .collect(),
        workflow_children: workflow_children
            .iter()
            .map(|id| (*id).to_owned())
            .collect(),
        children: children
            .iter()
            .map(|(id, status)| ((*id).to_owned(), (*status).to_owned()))
            .collect(),
    }));
    count
}

#[test]
fn a_fresh_session_counts_zero() {
    assert_eq!(CompletedActivity::default().count(), Some(0));
}

#[test]
fn an_unreadable_history_is_null_until_a_new_seed() {
    let mut count = CompletedActivity::default();
    count.seed(None);
    assert_eq!(count.count(), None);
    count.child("c1", Some("success"));
    assert_eq!(
        count.count(),
        None,
        "live facts do not turn a partial history into a total"
    );
    count.seed(Some(Seed {
        children: vec![("c1".to_owned(), "success".to_owned())],
        ..Seed::default()
    }));
    assert_eq!(count.count(), Some(1));
}

#[test]
fn nine_successes_then_failed_or_stopped_ones_still_give_nine() {
    let runs: Vec<(String, &str, i64)> = (0..9)
        .map(|index| (format!("run_{index}"), "completed", 3))
        .collect();
    let runs: Vec<(&str, &str, i64)> = runs
        .iter()
        .map(|(id, status, seq)| (id.as_str(), *status, *seq))
        .collect();
    let mut count = seeded(&runs, &[], &[]);
    count.run("run_failed", "failed", 4);
    count.run("run_stopped", "cancelled", 4);
    count.child("c_failed", Some("failed"));
    count.child("c_killed", Some("cancelled"));
    assert_eq!(count.count(), Some(9));
}

#[test]
fn successes_above_the_hundred_preview_are_all_counted() {
    let children: Vec<(String, &str)> = (0..105)
        .map(|index| (format!("child_{index}"), "success"))
        .collect();
    let children: Vec<(&str, &str)> = children
        .iter()
        .map(|(id, status)| (id.as_str(), *status))
        .collect();
    assert_eq!(seeded(&[], &[], &children).count(), Some(105));
}

#[test]
fn a_resumed_run_leaves_the_count_until_it_completes_again() {
    let mut count = seeded(&[("run_a", "completed", 5)], &[], &[]);
    count.run("run_a", "running", 6);
    assert_eq!(count.count(), Some(0));
    count.run("run_a", "completed", 9);
    assert_eq!(count.count(), Some(1));
}

#[test]
fn a_resumed_child_leaves_the_count_until_it_succeeds_again() {
    let mut count = seeded(&[], &[], &[("c1", "success")]);
    count.child("c1", None);
    assert_eq!(count.count(), Some(0));
    count.child("c1", Some("success"));
    assert_eq!(count.count(), Some(1));
}

#[test]
fn repeated_events_do_not_add_up() {
    let mut count = CompletedActivity::default();
    for _ in 0..3 {
        count.run("run_a", "completed", 7);
        count.child("c1", Some("success"));
    }
    assert_eq!(count.count(), Some(2));
}

#[test]
fn an_older_run_fact_does_not_overwrite_a_newer_one() {
    // A live delta can land before the cold seed that was read earlier.
    let mut count = CompletedActivity::default();
    count.run("run_a", "running", 8);
    count.seed(Some(Seed {
        runs: vec![("run_a".to_owned(), "completed".to_owned(), 5)],
        ..Seed::default()
    }));
    assert_eq!(count.count(), Some(0));
    count.run("run_a", "completed", 7);
    assert_eq!(
        count.count(),
        Some(0),
        "a delta older than the known one is ignored"
    );
}

#[test]
fn workflow_actor_sessions_are_not_counted_as_subagents() {
    let mut count = seeded(
        &[("run_a", "completed", 2)],
        &["actor_1"],
        &[("actor_1", "success"), ("c1", "success")],
    );
    assert_eq!(count.count(), Some(2), "the run and the standalone child");
    count.workflow_child("actor_2");
    count.child("actor_2", Some("success"));
    assert_eq!(count.count(), Some(2));
}

#[test]
fn a_reseed_replaces_the_child_outcomes() {
    // A rewind re-reads the active branch: a child whose launch was cut is gone.
    let mut count = seeded(&[], &[], &[("c1", "success"), ("c2", "success")]);
    count.seed(Some(Seed {
        children: vec![("c1".to_owned(), "success".to_owned())],
        ..Seed::default()
    }));
    assert_eq!(count.count(), Some(1));
}

#[test]
fn a_cold_open_with_history_is_null_until_seeded_and_an_empty_one_is_zero() {
    assert_eq!(CompletedActivity::opened(true).count(), None);
    assert_eq!(CompletedActivity::opened(false).count(), Some(0));
}
