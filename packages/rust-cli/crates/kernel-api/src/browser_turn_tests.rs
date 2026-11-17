//! Fork D2 (specs/fork-rust-node-helper.md, "D2 end-of-turn screenshot"): Node's `browser-turn-screenshot.test.ts` and
//! `browser-turn-state` are the oracle for the candidate guard, the consume-once rule and the display shape.

use serde_json::json;

use super::*;

fn meta(browser_id: Value, generation: Value) -> Value {
    json!({TURN_SCREENSHOT_META_KEY: {"browserGeneration": generation, "browserId": browser_id, "tabId": "tab-1"}})
}

#[test]
fn the_candidate_needs_a_string_browser_id_and_an_integer_generation() {
    let good = candidate_from_meta(Some(&meta(json!("iab-1"), json!(2))));
    assert_eq!(
        good,
        Some(BrowserCandidate {
            browser_id: "iab-1".into(),
            browser_generation: 2,
        })
    );
    assert_eq!(candidate_from_meta(Some(&meta(json!(7), json!(2)))), None);
    assert_eq!(
        candidate_from_meta(Some(&meta(json!("iab-1"), json!(2.5)))),
        None
    );
    assert_eq!(candidate_from_meta(Some(&json!({}))), None);
    assert_eq!(candidate_from_meta(None), None);
}

#[test]
fn a_candidate_is_taken_once_by_its_turn() {
    let session = "s-take-once";
    record(
        session,
        "t1",
        BrowserCandidate {
            browser_id: "iab-1".into(),
            browser_generation: 2,
        },
    );
    assert!(take(session, "t1").is_some());
    assert_eq!(take(session, "t1"), None, "consume removes the candidate");
}

#[test]
fn a_later_call_in_the_turn_replaces_the_candidate() {
    let session = "s-latest";
    let first = BrowserCandidate {
        browser_id: "iab-1".into(),
        browser_generation: 1,
    };
    let second = BrowserCandidate {
        browser_id: "iab-2".into(),
        browser_generation: 3,
    };
    record(session, "t1", first);
    record(session, "t1", second.clone());
    assert_eq!(take(session, "t1"), Some(second));
}

#[test]
fn a_turn_without_a_candidate_takes_nothing_and_other_turns_keep_theirs() {
    let session = "s-other-turns";
    record(
        session,
        "t-keep",
        BrowserCandidate {
            browser_id: "iab-1".into(),
            browser_generation: 1,
        },
    );
    assert_eq!(take(session, "t-none"), None);
    assert!(take(session, "t-keep").is_some());
}

#[test]
fn forgetting_a_session_drops_only_its_candidates() {
    let candidate = BrowserCandidate {
        browser_id: "iab-1".into(),
        browser_generation: 1,
    };
    record("s-forget", "t1", candidate.clone());
    record("s-kept", "t1", candidate);
    forget_session("s-forget");
    assert_eq!(take("s-forget", "t1"), None);
    assert!(take("s-kept", "t1").is_some());
}

#[test]
fn the_display_is_a_node_repl_images_row_with_the_turn_end_source() {
    let shot = CapturedScreenshot {
        base64: "AAAA".into(),
        mime_type: "image/png".into(),
    };
    assert_eq!(
        display(&shot),
        json!({
            "kind": "node_repl_images",
            "images": [{"base64": "AAAA", "mimeType": "image/png"}],
            "source": "browser_turn_end",
        })
    );
}

#[test]
fn the_display_budget_is_node_s_200_kib_of_base64() {
    assert!(fits_display(&"A".repeat(TURN_SCREENSHOT_MAX_BASE64_BYTES)));
    assert!(!fits_display(
        &"A".repeat(TURN_SCREENSHOT_MAX_BASE64_BYTES + 1)
    ));
}

#[test]
fn a_bound_port_is_found_by_its_session_until_unbound() {
    struct Never;
    #[async_trait]
    impl TurnScreenshotPort for Never {
        async fn capture(
            &self,
            _session: &str,
            _turn: &str,
            _candidate: &BrowserCandidate,
            _cancel: tokio_util::sync::CancellationToken,
        ) -> Option<CapturedScreenshot> {
            None
        }
    }
    bind("s-port", Arc::new(Never));
    assert!(port_for("s-port").is_some());
    unbind("s-port");
    assert!(port_for("s-port").is_none());
}
