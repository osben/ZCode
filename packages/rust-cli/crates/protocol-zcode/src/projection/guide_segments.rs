//! Fork: work segments of a turn that absorbed guided steers (Node `openGuidedWorkSegment` / `completeWorkSegments`,
//! `specs/fork-rust-guide-work-segments.md`). The turn header's `workSegments` gives each steer its own work section;
//! the CLI decides the boundaries, the UI never guesses them from adjacent rows.

use serde_json::{Map, Value, json};

use super::{Projection, turn_key};

impl Projection {
    /// A guided steer joined the turn at `now`: close the open segment and start the steer's own (Node
    /// `openGuidedWorkSegment`). The first steer of a turn also materializes the `<turn>:initial` segment that
    /// covers the work before it. Steers absorbed with no model step between them share one segment, and a
    /// control-only turn (no model call) has no work to split.
    pub(super) fn open_guided_work_segment(
        &mut self,
        turn: &str,
        trigger: &str,
        now: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(live) = self.turn.as_mut().filter(|live| live.id == turn) else {
            return;
        };
        if live.control_only || std::mem::replace(&mut live.guide_open, true) {
            return;
        }
        self.upsert(
            &turn_key(turn),
            |row| {
                let started = row.get("startedAt").and_then(Value::as_u64).unwrap_or(now);
                let mut segments = match row.get("workSegments") {
                    Some(Value::Array(segments)) => segments.clone(),
                    _ => {
                        vec![json!({"segmentId": format!("{turn}:initial"), "startedAt": started})]
                    }
                };
                complete_last(&mut segments, now);
                segments.push(json!({
                    "segmentId": trigger,
                    "triggerEntityId": trigger,
                    "startedAt": now,
                }));
                row.insert("workSegments".into(), Value::Array(segments));
            },
            out,
        );
    }

    /// The turn ended at `now`: close the open last segment (Node `completeWorkSegments`). A header without
    /// segments keeps none.
    pub(super) fn complete_work_segments(row: &mut Map<String, Value>, now: u64) {
        if let Some(Value::Array(segments)) = row.get_mut("workSegments") {
            complete_last(segments, now);
        }
    }
}

/// Sets `endedAt` and `activeMs` on the last segment when it is still open.
fn complete_last(segments: &mut [Value], now: u64) {
    let Some(Value::Object(last)) = segments.last_mut() else {
        return;
    };
    if last.contains_key("endedAt") {
        return;
    }
    let started = last.get("startedAt").and_then(Value::as_u64).unwrap_or(now);
    last.insert("endedAt".into(), json!(now));
    last.insert("activeMs".into(), json!(now.saturating_sub(started)));
}
