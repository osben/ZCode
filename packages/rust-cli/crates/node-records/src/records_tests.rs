//! Fork (B3): the grant receipt reads back only when it matches Node's strict schema.

use serde_json::{Value, json};

use super::*;

fn receipt() -> Value {
    json!({
        "interactionId": "int_1",
        "event": {
            "id": "evt_1",
            "sessionId": "s1",
            "traceId": "trace_s1",
            "type": "session_mode_changed",
            "timestamp": 1_700_000_000_000u64,
            "sequenceNumber": 0,
            "payload": {
                "mode": "guarded",
                "planEnabled": false,
                "previousMode": "build",
                "previousPlanEnabled": true,
                "source": "command",
                "permissionGrant": {"interactionId": "int_1", "queueItemIds": ["queue_c1"]},
            },
        },
    })
}

/// Node `permissionFullAccessReceiptSchema`: every level `.strict()`, the modes are enums, and the grant names the
/// receipt's interaction.
#[test]
fn a_grant_receipt_must_match_nodes_strict_schema() {
    assert_eq!(
        permission_grant_of("s1", &receipt()).as_deref(),
        Some("int_1")
    );
    let mut with_turn = receipt();
    with_turn["event"]["turnId"] = json!("turn_1");
    with_turn["event"]["timestamp"] = json!("2026-11-12T10:00:00.000Z");
    assert_eq!(
        permission_grant_of("s1", &with_turn).as_deref(),
        Some("int_1")
    );
    let broken: [(&str, Value); 14] = [
        ("/extra", json!(1)),
        ("/event/extra", json!(1)),
        ("/event/payload/extra", json!(1)),
        ("/event/payload/permissionGrant/extra", json!(1)),
        ("/event/payload/mode", json!("build")),
        ("/event/payload/previousMode", json!("bypassPermissions")),
        ("/event/payload/source", json!("user")),
        ("/event/payload/planEnabled", json!("no")),
        ("/event/sequenceNumber", json!(-1)),
        ("/event/traceId", json!("")),
        ("/event/timestamp", json!({})),
        ("/event/turnId", json!(5)),
        ("/event/payload/permissionGrant/queueItemIds", json!([""])),
        (
            "/event/payload/permissionGrant/interactionId",
            json!("int_2"),
        ),
    ];
    for (pointer, value) in broken {
        let mut data = receipt();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        data.pointer_mut(if parent.is_empty() { "" } else { parent })
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.to_owned(), value);
        assert_eq!(permission_grant_of("s1", &data), None, "{pointer}");
    }
    assert_eq!(permission_grant_of("s2", &receipt()), None);
}

/// The receipt Rust writes passes its own reader.
#[test]
fn the_written_receipt_passes_the_schema() {
    let queue = vec!["queue_c1".to_owned()];
    let entry = permission_full_access_entry(
        "s1",
        5,
        &GrantReceipt {
            interaction: "int_1",
            event: "evt_1",
            trace: "trace_s1",
            sequence: 2,
            previous: GrantState {
                mode: "build",
                plan: true,
            },
            next: GrantState {
                mode: "yolo",
                plan: true,
            },
            queue_items: &queue,
        },
    );
    assert_eq!(
        permission_grant_of("s1", &entry["data"]).as_deref(),
        Some("int_1")
    );
}

fn with_event_field(key: &str, value: Value) -> Value {
    let mut data = receipt();
    data["event"][key] = value;
    data
}

/// #423 review P2-2: `z.coerce.date()` is `new Date(value)` and fails on an Invalid Date. Results probed in Node 26:
/// booleans and null are dates (0 or 1 ms), a number is one within ±8.64e15 ms, a string is one in the ECMAScript
/// date-time format (V8 lets the day run to 31 and allows hour 24 at :00). `sequenceNumber` is `z.number().int()`, so
/// `1.0` passes.
#[test]
fn the_receipt_timestamp_follows_js_date() {
    let valid = [
        json!(true),
        json!(null),
        json!(-1),
        json!(1.5),
        json!(8.64e15),
        json!("2026-11-12T10:00:00.000Z"),
        json!("2026-11-12"),
        json!("2026-11"),
        json!("2026"),
        json!("2026-02-30"),
        json!("2026-11-12T10:00"),
        json!("2026-11-12T10:00:00.1234Z"),
        json!("2026-11-12T10:00:00+02:00"),
        json!("+002026-11-12T00:00:00Z"),
        json!("2026-11-12T24:00:00Z"),
    ];
    for value in valid {
        assert_eq!(
            permission_grant_of("s1", &with_event_field("timestamp", value.clone())).as_deref(),
            Some("int_1"),
            "{value}"
        );
    }
    let invalid = [
        json!(8.64e15 + 2.0),
        json!(""),
        json!("abc"),
        json!("1700000000000"),
        json!("2026-13-01"),
        json!("2026-11-32"),
        json!("2026-11-12T25:00Z"),
        json!("2026-11-12T24:00:01Z"),
        json!("2026-11-12T10:60Z"),
        json!("-000000-01-01T00:00:00Z"),
        json!("2026-11-12T10:00:00+2:00"),
        json!([]),
    ];
    for value in invalid {
        assert_eq!(
            permission_grant_of("s1", &with_event_field("timestamp", value.clone())),
            None,
            "{value}"
        );
    }
    for (value, expected) in [
        (json!(1.0), Some("int_1")),
        (json!(1.5), None),
        (json!(-1), None),
    ] {
        assert_eq!(
            permission_grant_of("s1", &with_event_field("sequenceNumber", value.clone()))
                .as_deref(),
            expected,
            "{value}"
        );
    }
}
