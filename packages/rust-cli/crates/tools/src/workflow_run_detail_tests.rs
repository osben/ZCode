//! 9.42: GetWorkflowRun's model text, with the blocks Node writes for the journal's projected state. The goldens are Node's
//! block wording (`get-workflow-run-format.ts`, `get-workflow-run-summary.ts`) for the same facts; the clock is fixed, so the
//! ages are exact.

use serde_json::{Value, json};

use super::format_detail;

/// The one clock reading of these tests: 3 minutes after the run was created.
const NOW: i64 = 1_180_000;

fn running() -> Value {
    json!({
        "runId": "wf_1",
        "label": "nightly",
        "labelSource": "name",
        "status": "running",
        "ownedByThisSession": true,
        "createdAt": 1_000_000,
        "updatedAt": 1_170_000,
        "usage": {
            "spentTokens": 42, "nodesObserved": 3, "nodesRunning": 1,
            "nodesCompleted": 2, "nodesFailed": 0
        }
    })
}

fn block<'a>(text: &'a str, tag: &str) -> &'a str {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text
        .find(&open)
        .unwrap_or_else(|| panic!("no <{tag}> in {text}"))
        + open.len();
    let end = text[start..]
        .find(&close)
        .map(|at| start + at)
        .unwrap_or_else(|| panic!("no </{tag}> in {text}"));
    &text[start..end]
}

#[test]
fn a_pending_question_is_written_with_its_id_asker_age_question_and_context() {
    let mut detail = running();
    detail["pendingQuestions"] = json!([{
        "qid": "dwfq-wf_1-0", "actor": "agent#1@1", "actorName": "poet",
        "question": "which branch?", "context": "after the fetch", "askedAt": 1_120_000
    }]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "pending_questions"),
        "\n[dwfq-wf_1-0] poet asked 1m 00s ago\nwhich branch?\ncontext: after the fetch\n\nEach of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.\n"
    );
    assert!(
        text.starts_with("<summary>Running for 3m 00s. 1 question awaiting your answer.</summary>"),
        "{text}"
    );
}

#[test]
fn a_question_with_no_actor_name_is_named_by_its_actor() {
    let mut detail = running();
    detail["pendingQuestions"] = json!([{
        "qid": "dwfq-wf_1-1", "actor": "agent#2@2", "question": "ok?", "askedAt": 1_000_000
    }]);
    let text = format_detail(&detail, NOW);
    assert!(
        text.contains("[dwfq-wf_1-1] agent#2@2 asked 3m 00s ago\nok?"),
        "{text}"
    );
}

#[test]
fn no_pending_block_is_written_when_no_question_waits() {
    let text = format_detail(&running(), NOW);
    assert!(!text.contains("<pending_questions>"), "{text}");
    assert!(!text.contains("unknown"), "{text}");
}

#[test]
fn a_waiting_hole_is_written_with_its_name_type_and_age_and_the_fill_instruction() {
    let mut detail = running();
    detail["holes"] = json!([{
        "siteId": "gate#1", "ordinal": 1, "name": "pick", "type": "string",
        "state": "waiting", "since": 1_150_000
    }]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "holes"),
        "\n[gate#1] \"pick\": string — waiting 30s\n\nEach waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"wf_1\" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.\n"
    );
    assert!(
        text.starts_with("<summary>Running for 3m 00s. 1 hole awaiting your code.</summary>"),
        "{text}"
    );
}

#[test]
fn a_filled_hole_says_it_is_filled_by_whom_and_when() {
    let mut detail = running();
    detail["holes"] = json!([{
        "siteId": "gate#1", "ordinal": 1, "name": "pick", "type": "string",
        "state": "filled", "filledAt": 1_160_000, "filledBy": "user"
    }]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "holes"),
        "\n[gate#1] \"pick\": string — filled 20s ago by user\n\nEvery hole above has been filled; its body is part of the run's script now (see <amendable> to change it).\n"
    );
}

#[test]
fn the_usage_block_has_the_spent_tokens_and_the_four_node_counts() {
    let text = format_detail(&running(), NOW);
    assert_eq!(
        block(&text, "usage"),
        "spent_tokens=42 nodes_observed=3 nodes_running=1 nodes_completed=2 nodes_failed=0"
    );
}

#[test]
fn a_completed_run_names_its_primary_deliverable_and_lists_its_artifacts() {
    let detail = json!({
        "runId": "wf_done", "label": "nightly", "labelSource": "name", "status": "completed",
        "ownedByThisSession": true, "createdAt": 1_000, "updatedAt": 2_000,
        "usage": {"spentTokens": 7, "nodesObserved": 1, "nodesRunning": 0, "nodesCompleted": 1, "nodesFailed": 0},
        "artifacts": [{"id": "art-1", "kind": "file", "title": "Report", "primary": true, "itemCount": 1}]
    });
    let text = format_detail(&detail, NOW);
    assert!(
        text.starts_with(
            "<summary>Completed in 1s. Deliverable: Report (file, primary).</summary>"
        ),
        "{text}"
    );
    assert!(
        text.contains("<artifacts count=\"1\">\n[art-1] file: Report (primary)\n</artifacts>"),
        "{text}"
    );
}

#[test]
fn an_ask_that_is_not_settled_and_a_hole_count_are_both_said_in_the_summary() {
    let mut detail = running();
    detail["pendingQuestions"] = json!([
        {"qid": "q1", "question": "a?", "askedAt": 1_100_000},
        {"qid": "q2", "question": "b?", "askedAt": 1_100_000}
    ]);
    let text = format_detail(&detail, NOW);
    assert!(text.contains("2 questions awaiting your answer."), "{text}");
}
