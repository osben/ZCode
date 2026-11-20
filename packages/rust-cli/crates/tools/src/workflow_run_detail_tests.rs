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
        },
        "health": {"consecutiveFailures": 0, "cachedSteps": 0, "pendingQuestionsKnown": true}
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
        text.starts_with("<summary>Running for 3m 00s. 2 of 3 dispatched steps settled, 1 running. 1 question awaiting your answer.</summary>"),
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
        text.starts_with("<summary>Running for 3m 00s. 2 of 3 dispatched steps settled, 1 running. 1 hole awaiting your code.</summary>"),
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
        "artifacts": [{"id": "art-1", "kind": "file", "title": "Report", "primary": true, "itemCount": 1}],
        "health": {"consecutiveFailures": 0, "cachedSteps": 0, "pendingQuestionsKnown": true}
    });
    let text = format_detail(&detail, NOW);
    assert!(
        text.starts_with(
            "<summary>Completed in 1s. 1 step settled, 7 tokens. Deliverable: Report (file, primary).</summary>"
        ),
        "{text}"
    );
    assert!(
        text.contains("<artifacts count=\"1\">\n[art-1] file: Report (primary)\n</artifacts>"),
        "{text}"
    );
}

#[test]
fn two_questions_and_two_waiting_holes_are_both_counted_in_the_summary() {
    let mut detail = running();
    detail["pendingQuestions"] = json!([
        {"qid": "q1", "question": "a?", "askedAt": 1_100_000},
        {"qid": "q2", "question": "b?", "askedAt": 1_100_000}
    ]);
    detail["holes"] = json!([
        {"siteId": "h1", "ordinal": 1, "name": "x", "state": "waiting", "since": 1_150_000},
        {"siteId": "h2", "ordinal": 2, "name": "y", "state": "waiting", "since": 1_150_000}
    ]);
    let text = format_detail(&detail, NOW);
    assert!(
        text.starts_with(
            "<summary>Running for 3m 00s. 2 of 3 dispatched steps settled, 1 running. 2 questions awaiting your answer. 2 holes awaiting your code.</summary>"
        ),
        "{text}"
    );
}

#[test]
fn the_identity_block_writes_the_concurrency_limit_and_the_subagent_model_after_resumed_from() {
    let mut detail = running();
    detail["resumedFrom"] = json!("wf_old");
    detail["maxConcurrency"] = json!(2);
    detail["subagentModel"] = json!("m-1");
    let text = format_detail(&detail, NOW);
    let resumed = text
        .find("<resumed_from>wf_old</resumed_from>")
        .expect("resumed_from");
    let limit = text
        .find("<max_concurrency>2</max_concurrency>")
        .expect("max_concurrency");
    let model = text
        .find("<subagent_model>m-1</subagent_model>")
        .expect("subagent_model");
    assert!(resumed < limit && limit < model, "{text}");
}

#[test]
fn a_hole_without_a_type_is_written_without_one() {
    let mut detail = running();
    detail["holes"] = json!([{
        "siteId": "gate#1", "ordinal": 1, "name": "pick", "state": "waiting", "since": 1_150_000
    }]);
    let text = format_detail(&detail, NOW);
    assert!(text.contains("[gate#1] \"pick\" — waiting 30s"), "{text}");
}

/// Every value the text interpolates is escaped, numbers included, so a value that is not a plain number cannot break the
/// block structure of the model text (ocr #600 round 2).
#[test]
fn the_usage_and_the_concurrency_limit_are_escaped_like_every_other_value() {
    let mut detail = running();
    detail["usage"]["spentTokens"] = json!("<7>");
    detail["maxConcurrency"] = json!("</usage><x>");
    let text = format_detail(&detail, NOW);
    assert!(
        text.contains("<usage>spent_tokens=&lt;7&gt; nodes_observed=3"),
        "{text}"
    );
    assert!(
        text.contains("<max_concurrency>&lt;/usage&gt;&lt;x&gt;</max_concurrency>"),
        "{text}"
    );
}

// ——— 9.46: the roster family, the summary clauses, the provider stop and the amendable block (Node wording) ———

/// Node `formatWorkflowRunHealthBlock`: cells joined by two spaces; the stall cell only for a live run.
#[test]
fn the_health_block_writes_progress_concurrency_stall_failures_and_cache() {
    let mut detail = running();
    detail["health"] = json!({
        "lastProgressAt": 1_170_000, "stalledSince": 1_100_000,
        "concurrency": {"effective": 2, "cap": 4, "reason": "rate_limit", "since": 1_150_000},
        "consecutiveFailures": 2, "cachedSteps": 1, "pendingQuestionsKnown": true
    });
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "health"),
        "last_progress=10s ago  concurrency=2/4 (rate_limit since 30s ago)  stalled=since 1m 20s ago  consecutive_failures=2  cached_steps=1"
    );
}

/// Node: a terminal run has no stall cell, and says which `running` rows are leftovers of the process that exited.
#[test]
fn the_health_of_an_interrupted_run_explains_its_leftover_running_steps() {
    let mut detail = running();
    detail["status"] = json!("stopped");
    detail["stopReason"] = json!("interrupted");
    detail["health"] = json!({"consecutiveFailures": 0, "cachedSteps": 0, "leftoverRunning": 2, "pendingQuestionsKnown": true});
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "health"),
        "consecutive_failures=0  cached_steps=0\nThe 2 \"running\" steps below are leftovers of the exited process, not live work."
    );
}

/// Node `buildWorkflowRunSummary`: status and current phase, the step count with the subagent breakdown, the stall clause.
#[test]
fn the_summary_names_the_current_phase_the_steps_and_a_stall() {
    let mut detail = running();
    detail["phases"] = json!([
        {"name": "plan", "state": "done", "rounds": 1, "nodesSettled": 2, "nodesRunning": 0},
        {"name": "build", "state": "current", "rounds": 2, "nodesSettled": 0, "nodesRunning": 1, "enteredAt": 1_100_000},
        {"name": "ship", "state": "ahead", "rounds": 0, "nodesSettled": 0, "nodesRunning": 0}
    ]);
    detail["health"]["lastProgressAt"] = json!(1_170_000);
    detail["health"]["stalledSince"] = json!(1_100_000);
    let text = format_detail(&detail, NOW);
    assert!(
        text.starts_with("<summary>Running for 3m 00s, in phase 2 of 3 (build). 2 of 3 dispatched steps settled, 1 running. Stalled, last progress 10s ago.</summary>"),
        "{text}"
    );
}

/// Node: a stopped run's summary says how long ago it stopped, the failure code, and the leftover steps with their ending.
#[test]
fn the_summary_of_an_interrupted_run_gives_its_stop_and_its_leftover_steps() {
    let mut detail = running();
    detail["status"] = json!("stopped");
    detail["stopReason"] = json!("interrupted");
    detail["updatedAt"] = json!(1_170_000);
    detail["health"] = json!({"consecutiveFailures": 0, "cachedSteps": 0, "leftoverRunning": 1, "pendingQuestionsKnown": true});
    let text = format_detail(&detail, NOW);
    assert!(
        text.starts_with("<summary>Stopped (interrupted) 10s ago after 2m 50s. 2 of 3 dispatched steps settled; 1 was still running when the owning process exited and will be re-dispatched on resume.</summary>"),
        "{text}"
    );
}

/// Node `formatWorkflowRunPhasesBlock`: name, state, rounds, counts and duration as aligned cells; `ahead` rows are bare.
#[test]
fn the_phases_block_aligns_each_phase_with_its_rounds_counts_and_durations() {
    let mut detail = running();
    detail["phases"] = json!([
        {"name": "plan", "state": "done", "rounds": 1, "nodesSettled": 2, "nodesRunning": 0, "enteredAt": 1_000_000, "exitedAt": 1_060_000},
        {"name": "build", "state": "current", "rounds": 2, "nodesSettled": 0, "nodesRunning": 1, "enteredAt": 1_100_000},
        {"name": "ship", "state": "ahead", "rounds": 0, "nodesSettled": 0, "nodesRunning": 0}
    ]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "phases"),
        "\n1. plan   done     1 round  2 steps settled  1m 00s\n2. build  current  2 rounds  0 settled, 1 running  1m 20s so far\n3. ship   ahead\n"
    );
}

/// Node `formatWorkflowRunSubagentsBlock`: who, where, which state, the phase, the current ask with its progress, and the task row.
#[test]
fn the_subagents_block_writes_each_row_with_its_activity_and_its_task() {
    let mut detail = running();
    detail["subagents"] = json!([
        {
            "siteId": "poet", "ordinal": 1, "name": "poet", "state": "executing", "phaseName": "plan",
            "currentAsk": {
                "siteId": "poet", "ordinal": 1, "actorSeq": 2, "instructionsHead": "draft the verse",
                "startedAt": 1_170_000, "turn": 3, "toolCalls": 2,
                "lastTool": {"name": "Read", "target": "a.md", "at": 1_175_000}
            },
            "stepsSettled": 2, "stepsFailed": 0, "tokens": 1_234
        },
        {
            "siteId": "critic", "ordinal": 2, "name": "critic", "state": "parked", "parkedOn": "q-1",
            "stepsSettled": 0, "stepsFailed": 0, "tokens": 0
        },
        {
            "siteId": "fetch", "ordinal": 3, "state": "waiting",
            "wait": {"cause": "backoff", "reason": "429", "retryAfterMs": 5_000, "since": 1_150_000},
            "stepsSettled": 1, "stepsFailed": 1, "tokens": 0
        }
    ]);
    detail["pendingQuestions"] =
        json!([{"qid": "q-1", "actor": "critic@2", "question": "which?", "askedAt": 1_100_000}]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "subagents"),
        "\npoet    poet@1    executing  phase plan  poet@1 (step 3), 10s on this step, turn 3, 2 tool calls, last Read a.md 5s ago  1,234 tokens\n  task: draft the verse\ncritic  critic@2  parked     on question q-1 for 1m 20s\n        fetch@3   waiting    backoff after 429 for 30s, retry in 5s\n"
    );
}

#[test]
fn an_empty_roster_says_no_subagents_were_created_and_a_cut_roster_says_so() {
    let text = format_detail(&running(), NOW);
    assert!(
        text.contains("<subagents>No subagents created yet.</subagents>"),
        "{text}"
    );
    let mut detail = running();
    detail["subagents"] = json!([{"siteId": "a", "ordinal": 1, "state": "idle", "stepsSettled": 0, "stepsFailed": 0, "tokens": 0}]);
    detail["subagentsTruncated"] = json!(true);
    let text = format_detail(&detail, NOW);
    assert!(
        block(&text, "subagents")
            .ends_with("\nOnly the first 1 subagents are listed; this run has more.\n"),
        "{text}"
    );
}

/// Node `formatWorkflowRunLogTailBlock`: the sequence, the age when the event has a time, and the escaped message.
#[test]
fn the_log_tail_writes_each_line_with_its_sequence_age_and_message() {
    let text = format_detail(&running(), NOW);
    assert!(
        text.contains("<log_tail>No log() narration recorded yet.</log_tail>"),
        "{text}"
    );
    let mut detail = running();
    detail["logTail"] = json!([
        {"sequence": 6, "message": "fetching <a>", "at": 1_120_000},
        {"sequence": 7, "message": "done"}
    ]);
    let text = format_detail(&detail, NOW);
    assert_eq!(
        block(&text, "log_tail"),
        "\n[6]  1m 00s ago  fetching &lt;a&gt;\n[7]  done\n"
    );
}

/// Node: the pending-question block says the question list is unknown when the read cannot see it.
#[test]
fn an_unknown_question_list_is_said_to_be_unknown() {
    let mut detail = running();
    detail["health"]["pendingQuestionsKnown"] = json!(false);
    let text = format_detail(&detail, NOW);
    assert!(
        block(&text, "pending_questions").starts_with(
            "Unknown: pending questions are tracked only by the process that owns the run"
        ),
        "{text}"
    );
    assert!(
        text.contains("Pending questions are unknown from this session."),
        "{text}"
    );
}

/// Node: a stopped-by-provider run carries the provider stop's sentences, facts and raw message, unescaped, in `<error>`.
#[test]
fn a_provider_stop_is_written_with_its_cause_action_facts_and_raw_message() {
    let mut detail = running();
    detail["status"] = json!("stopped");
    detail["stopReason"] = json!("provider");
    detail["error"] = json!({
        "code": "ProviderStop", "message": "quota",
        "providerStop": {
            "kind": "quota", "reason": "rate_limited", "providerCode": "1113", "providerId": "zai",
            "providerLabel": "Z.ai", "modelId": "glm-5", "subagent": "poet@1", "subagentName": "poet",
            "phase": "plan", "resetAt": 1_190_000, "rawMessage": "limit reached"
        }
    });
    let text = format_detail(&detail, NOW);
    let open = "<error code=\"ProviderStop\">";
    let start = text.find(open).expect("the error block") + open.len();
    let body = &text[start
        ..text[start..]
            .find("</error>")
            .map(|at| start + at)
            .expect("close")];
    assert_eq!(
        body,
        "\nZ.ai reports the user's usage cap is reached (code 1113); it resets at 1970-01-01T00:19:50.000Z.\nZCode resumes this run by itself a minute after the reset, while this session is open or the next time it is opened. Tell the user; do not call ResumeWorkflowRun before the reset, and do not rebuild the workflow.\nprovider=zai model=glm-5 subagent=poet@1 phase=plan code=1113\nraw: limit reached\n"
    );
    assert!(text.contains("<error code=\"ProviderStop\">"), "{text}");
    assert!(text.contains("Failure: ProviderStop."), "{text}");
}

/// Node `formatAmendableHint`: a healthy running run gets one sentence; the script file sentence follows when there is one.
#[test]
fn a_healthy_running_run_gets_the_one_sentence_amendable_block_with_its_script_file() {
    let mut detail = running();
    detail["scriptPath"] = json!("scripts/flow.js");
    let text = format_detail(&detail, NOW);
    assert!(
        text.contains("<amendable>AmendWorkflow with run_id \"wf_1\" supersedes this run with a revised script and imports its finished work as cache. Its script is at scripts/flow.js: edit that file in place and pass `path: \"scripts/flow.js\"` to AmendWorkflow instead of a script.</amendable>"),
        "{text}"
    );
}

/// Node: an errored run's amendable block is the full routing argument, and says the script itself failed.
#[test]
fn an_errored_run_gets_the_full_amendable_block_for_a_script_failure() {
    let mut detail = running();
    detail["status"] = json!("errored");
    detail["error"] = json!({"code": "DriverError", "message": "boom"});
    let text = format_detail(&detail, NOW);
    assert!(
        text.contains("<amendable>This run can be superseded by a revised script: call AmendWorkflow with `run_id: \"wf_1\"` and your new script. That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live. To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script. This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch.</amendable>"),
        "{text}"
    );
}

/// Node: a stalled running run gets the full block, not the one sentence.
#[test]
fn a_stalled_running_run_gets_the_full_amendable_block() {
    let mut detail = running();
    detail["health"]["stalledSince"] = json!(1_100_000);
    let text = format_detail(&detail, NOW);
    assert!(
        text.contains("It is still running: if the script is visibly wrong, amend it now"),
        "{text}"
    );
}

/// Node: the model bindings of the launch are written after the subagent model, one `"name" = model` line each.
#[test]
fn the_script_models_block_follows_the_subagent_model() {
    let mut detail = running();
    detail["subagentModel"] = json!("m-1");
    detail["modelBindings"] = json!({"poet": "openai/gpt-x"});
    let text = format_detail(&detail, NOW);
    let model = text
        .find("<subagent_model>m-1</subagent_model>")
        .expect("subagent_model");
    let bindings = text
        .find("<script_models>\n\"poet\" = openai/gpt-x\n</script_models>")
        .expect("script_models");
    assert!(model < bindings, "{text}");
}

/// Node `buildWorkflowRunSummary`: a summary longer than 400 characters is cut at 399 and an ellipsis.
#[test]
fn a_summary_over_the_budget_is_cut_with_an_ellipsis() {
    let mut detail = running();
    detail["phases"] = json!([{"name": "p".repeat(420), "state": "current", "rounds": 1, "nodesSettled": 0, "nodesRunning": 0}]);
    let text = format_detail(&detail, NOW);
    let summary = block(&text, "summary");
    assert_eq!(summary.encode_utf16().count(), 400, "{summary}");
    assert!(summary.ends_with('…'), "{summary}");
}

/// Divergence 565: a detail with no situation snapshot (the registry gap form) writes no health block, so no zero stands for a
/// fact the read does not have, and its parked questions are written as unknown.
#[test]
fn a_detail_without_a_situation_snapshot_writes_no_health_block_and_says_the_questions_are_unknown()
{
    let gap = json!({
        "runId": "wf_gap", "label": "nightly", "labelSource": "name", "status": "pending",
        "ownedByThisSession": true, "createdAt": 1_000_000, "updatedAt": 1_000_000,
        "usage": {"spentTokens": 0}
    });
    let text = format_detail(&gap, NOW);
    assert!(!text.contains("<health>"), "{text}");
    assert!(
        text.contains("Unknown: pending questions are tracked only by the process"),
        "{text}"
    );
    assert!(text.starts_with("<summary>Pending, not dispatched yet. Pending questions are unknown from this session.</summary>"), "{text}");
}
