//! `origin_meta` for a no-progress reminder (Node `subagent-stall-reminder.ts`): the title and the `subagentStall`
//! fields are read back from the reminder text, so the live projection and a cold read agree.

use serde_json::json;

use super::{origin_meta, origin_meta_with_execution, parse_iso_ms};

/// The reminder's own block, as the agents crate formats it (`agents/src/stall_golden.json`, `basic`).
fn reminder(description: &str, no_progress_ms: u64, last_progress: &str) -> String {
    format!(
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<background-agent-stall>\n  <task-id>agent_abc</task-id>\n  <description>{description}</description>\n  <running-for-ms>1200000</running-for-ms>\n  <no-progress-for-ms>{no_progress_ms}</no-progress-for-ms>\n  <last-progress-at>{last_progress}</last-progress-at>\n  <next-report-in-ms>1800000</next-report-in-ms>\n</background-agent-stall>\n\nBackground agent \"{description}\" (agent_abc) has been running for 20 minutes."
    )
}

#[test]
fn a_reminder_has_the_subagent_meta_with_its_stall_fields() {
    let meta = origin_meta(&reminder(
        "Run the test suite",
        900_000,
        "2024-11-07T17:20:00.000Z",
    ));
    assert_eq!(
        meta,
        Some(json!({
            "backgroundSource": "subagent",
            "title": "Run the test suite — no progress for 15 min",
            "workId": "agent_abc",
            "subagentStall": {"noProgressForMs": 900_000, "lastProgressAt": 1_731_000_000_000u64},
        }))
    );
}

#[test]
fn the_title_rounds_the_wait_to_minutes_and_is_at_least_one() {
    let short = origin_meta(&reminder("x", 29_999, "2024-11-07T17:20:00.000Z")).unwrap();
    assert_eq!(short["title"], "x — no progress for 1 min");
    let long = origin_meta(&reminder("x", 150 * 60_000, "2024-11-07T17:20:00.000Z")).unwrap();
    assert_eq!(long["title"], "x — no progress for 150 min");
}

#[test]
fn the_description_is_unescaped_for_the_title() {
    let meta = origin_meta(&reminder(
        "Fix &lt;b&gt; &amp; &quot;q&quot; &apos;x&apos;",
        120_000,
        "2024-11-07T17:20:00.000Z",
    ))
    .unwrap();
    assert_eq!(meta["title"], "Fix <b> & \"q\" 'x' — no progress for 2 min");
}

#[test]
fn a_last_progress_time_that_is_not_iso_gives_no_meta() {
    assert_eq!(
        origin_meta(&reminder("x", 60_000, "yesterday")),
        None,
        "a reminder the UI cannot read is untitled"
    );
}

#[test]
fn iso_times_round_trip_through_the_base_formatter() {
    for ms in [
        0u64,
        1,
        999,
        1_731_000_000_123,
        951_782_400_000,
        4_102_444_799_999,
    ] {
        let text = rust_cli_base::js::date::iso_timestamp(ms);
        assert_eq!(parse_iso_ms(&text), Some(ms), "{text}");
    }
    assert_eq!(parse_iso_ms("2024-13-01T00:00:00.000Z"), None);
    assert_eq!(parse_iso_ms("2024-11-07 17:20:00.000Z"), None);
}

/// Node writes `subagentStall` as `noProgressForMs`, `lastProgressAt`, then `executionId` (when the reminder has one).
/// The stored JSON keeps insertion order (serde_json `preserve_order`), so the text itself shows the order.
#[test]
fn a_stall_meta_gets_the_execution_after_last_progress() {
    let text = reminder("Run the test suite", 900_000, "2024-11-07T17:20:00.000Z");
    let meta = origin_meta_with_execution(&text, Some("3")).unwrap();
    assert_eq!(
        meta["subagentStall"],
        json!({"noProgressForMs": 900_000, "lastProgressAt": 1_731_000_000_000u64, "executionId": "3"})
    );
    let stored = serde_json::to_string(&meta).unwrap();
    let order = [
        "\"noProgressForMs\":900000",
        "\"lastProgressAt\":1731000000000",
        "\"executionId\":\"3\"",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|key| stored.find(key).expect(key))
        .collect();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "{stored}"
    );
}

#[test]
fn no_execution_or_no_stall_leaves_the_meta_unchanged() {
    let text = reminder("x", 900_000, "2024-11-07T17:20:00.000Z");
    assert_eq!(origin_meta_with_execution(&text, None), origin_meta(&text));
    let plain = "<task-notification>\n<task-id>agent_1</task-id>\n<summary>Agent \"First\" completed</summary>\n</task-notification>";
    assert_eq!(
        origin_meta_with_execution(plain, Some("3")),
        origin_meta(plain)
    );
}

/// Node `orderTaskNotificationsForParsing` before `resolveBackgroundTaskNotificationOriginMeta`: a batch's title and
/// source come from its first terminal notice, even when a stall reminder arrived first.
#[test]
fn a_batch_takes_its_representative_from_the_terminal_notice_not_the_stall() {
    let stall_meta = origin_meta(&reminder("Silent job", 900_000, "2024-11-07T17:20:00.000Z"));
    let terminal = origin_meta(
        "<task-notification>\n<task-id>bash_1</task-id>\n<summary>Background command \"Build\" completed</summary>\n</task-notification>",
    );
    let batch = super::batch_meta(&[stall_meta, terminal]).unwrap();
    assert_eq!(batch["backgroundSource"], "bash");
    assert_eq!(batch["workId"], "bash_1");
    assert_eq!(
        batch["title"],
        "Build · Silent job — no progress for 15 min"
    );
    assert!(batch.get("subagentStall").is_none());
}
