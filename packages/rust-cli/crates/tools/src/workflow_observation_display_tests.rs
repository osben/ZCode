//! Tests of the GetWorkflowRun and ListWorkflowRuns result cards (9.61).

use serde_json::json;

use super::{get_display, list_display};

#[test]
fn the_status_card_carries_the_summary_and_only_the_schemas_keys() {
    let detail = json!({
        "runId": "run_1", "label": "E2E", "labelSource": "name", "status": "running", "name": "E2E",
        "ownedByThisSession": true, "createdAt": 1_000, "updatedAt": 2_000, "scriptPath": "a.dwf.ts",
        "usage": {"spentTokens": 140, "nodesObserved": 3, "nodesRunning": 1, "nodesCompleted": 2, "nodesFailed": 0},
        "phases": [{"name": "准备", "state": "done", "rounds": 1, "nodesSettled": 1, "nodesRunning": 0, "enteredAt": 5, "extra": 1}],
        "subagents": [{
            "siteId": "actor#2", "ordinal": 1, "name": "核对员", "state": "parked", "phaseName": "核对",
            "currentAsk": {"instructionsHead": "E2E", "startedAt": 7, "turn": 2, "toolCalls": 1,
                           "lastTool": {"name": "Read", "target": "a.md", "at": 8, "other": 0}},
            "wait": {"cause": "backoff", "retryAfterMs": 50, "since": 9, "reason": "free text"},
            "parkedOn": "dwfq-0", "stepsSettled": 1, "stepsFailed": 0, "tokens": 140, "lastProgressAt": 9
        }],
        "health": {"lastProgressAt": 9, "consecutiveFailures": 0, "cachedSteps": 0, "pendingQuestionsKnown": true,
                   "concurrency": {"effective": 1, "cap": 2, "reason": "slow", "since": 3, "x": 1}},
        "actors": [{"siteId": "actor#2", "ordinal": 1, "name": "核对员", "persona": "p"}],
        "logTail": [{"sequence": 10, "message": "E2E_DWL_LOG", "at": 9, "kind": "log"}],
        "pendingQuestions": [{"qid": "dwfq-0"}],
        "error": {"code": "E", "message": "m", "providerStop": {"providerId": "p"}}
    });
    let card = get_display(&detail, 10_000);
    assert_eq!(card["kind"], "get_workflow_run");
    assert_eq!(card["runId"], "run_1");
    assert_eq!(card["label"], "E2E");
    assert_eq!(card["status"], "running");
    assert_eq!(card["generatedAt"], 10_000);
    assert!(
        card["summary"]
            .as_str()
            .is_some_and(|summary| summary.starts_with("Running for 9s")),
        "{card}"
    );
    assert_eq!(card["usage"], detail["usage"]);
    assert_eq!(
        card["phases"],
        json!([{"name": "准备", "state": "done", "rounds": 1, "nodesSettled": 1, "nodesRunning": 0, "enteredAt": 5}])
    );
    assert_eq!(
        card["subagents"],
        json!([{
            "siteId": "actor#2", "ordinal": 1, "name": "核对员", "state": "parked", "phaseName": "核对",
            "instructionsHead": "E2E", "startedAt": 7, "turn": 2, "toolCalls": 1,
            "lastTool": {"name": "Read", "target": "a.md", "at": 8},
            "waitCause": "backoff", "retryAfterMs": 50, "waitSince": 9, "parkedOn": "dwfq-0",
            "stepsSettled": 1, "stepsFailed": 0, "tokens": 140, "lastProgressAt": 9
        }])
    );
    assert_eq!(
        card["health"],
        json!({"lastProgressAt": 9, "consecutiveFailures": 0, "cachedSteps": 0, "pendingQuestionsKnown": true,
               "concurrency": {"effective": 1, "cap": 2, "reason": "slow", "since": 3}})
    );
    assert_eq!(
        card["actors"],
        json!([{"siteId": "actor#2", "ordinal": 1, "name": "核对员"}])
    );
    assert_eq!(
        card["logTail"],
        json!([{"sequence": 10, "message": "E2E_DWL_LOG", "at": 9}])
    );
    assert_eq!(card["error"], json!({"code": "E", "message": "m"}));
    let keys: Vec<&str> = card
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    for key in &keys {
        assert!(
            [
                "kind",
                "runId",
                "label",
                "status",
                "stopReason",
                "possiblyInterrupted",
                "summary",
                "generatedAt",
                "usage",
                "phases",
                "subagents",
                "health",
                "actors",
                "logTail",
                "result",
                "error",
                "truncated"
            ]
            .contains(key),
            "{key} is not a card key"
        );
    }
    assert!(card.get("truncated").is_none());
}

#[test]
fn the_status_card_bounds_the_log_tail_and_the_result_and_says_it_was_cut() {
    let log: Vec<_> = (0..45)
        .map(|n| json!({"sequence": n, "message": format!("line {n}")}))
        .collect();
    let detail = json!({
        "runId": "run_1", "label": "x", "status": "completed", "stopReason": null, "possiblyInterrupted": false,
        "usage": {"spentTokens": 0}, "subagents": [], "actors": [], "logTail": log,
        "result": "r".repeat(4_100)
    });
    let card = get_display(&detail, 1);
    let tail = card["logTail"].as_array().unwrap();
    assert_eq!(tail.len(), 40);
    assert_eq!(tail[0]["sequence"], 5);
    let result = card["result"].as_str().unwrap();
    assert!(result.ends_with("\n...[truncated]"));
    assert_eq!(result.len(), 4_000);
    assert_eq!(card["truncated"], true);
    assert!(card.get("possiblyInterrupted").is_none());
    assert!(card.get("stopReason").is_none());
    assert!(card.get("phases").is_none());
}

#[test]
fn the_list_card_carries_the_rows_schema_keys_and_the_truncation() {
    let page = json!({
        "runs": [{"runId": "run_1", "label": "x", "labelSource": "name", "status": "stopped", "stopReason": "superseded",
                  "ownedByThisSession": true, "createdAt": 1, "updatedAt": 2, "spentTokens": 3,
                  "supersededBy": "run_2", "name": "x", "cwd": "/w"}],
        "truncated": true
    });
    assert_eq!(
        list_display(&page),
        json!({"kind": "list_workflow_runs", "runs": [{"runId": "run_1", "label": "x", "labelSource": "name",
               "status": "stopped", "stopReason": "superseded", "ownedByThisSession": true, "createdAt": 1,
               "updatedAt": 2, "spentTokens": 3, "supersededBy": "run_2"}], "truncated": true})
    );
    assert_eq!(
        list_display(&json!({"runs": []})),
        json!({"kind": "list_workflow_runs", "runs": []})
    );
}
