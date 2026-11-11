use super::*;

#[test]
fn a_guide_steers_only_into_a_running_turn() {
    let guide = Some(Requested::Guide);
    assert_eq!(
        admission(guide, Followup::Queue, Phase::Running, true, false),
        (Delivery::Steer, "guide")
    );
    assert_eq!(
        admission(None, Followup::Guide, Phase::Running, true, false),
        (Delivery::Steer, "guide")
    );
    // A session job without a turn (the goal completion verifier): a future queue item, like Node.
    assert_eq!(
        admission(guide, Followup::Queue, Phase::Running, false, false),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(None, Followup::Guide, Phase::Running, false, false),
        (Delivery::Queue, "queue")
    );
}

#[test]
fn attachments_queue_and_an_idle_session_starts_now() {
    assert_eq!(
        admission(
            Some(Requested::Guide),
            Followup::Guide,
            Phase::Running,
            true,
            true
        ),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(None, Followup::Queue, Phase::Running, true, false),
        (Delivery::Queue, "queue")
    );
    assert_eq!(
        admission(
            Some(Requested::Guide),
            Followup::Guide,
            Phase::CompletedSuccess,
            false,
            false
        ),
        (Delivery::Queue, "startNow")
    );
}

#[test]
fn only_an_explicit_start_now_preempts_a_running_turn() {
    let envelope = |payload: serde_json::Value| -> Envelope {
        serde_json::from_value(json!({
            "commandId": "c1",
            "clientId": "desktop",
            "sessionId": "s1",
            "type": "sendText",
            "payload": payload,
        }))
        .unwrap()
    };
    assert!(requests_start_now(&envelope(
        json!({"text": "now", "requestedDelivery": "startNow"})
    )));
    assert!(!requests_start_now(&envelope(
        json!({"text": "later", "requestedDelivery": "queue"})
    )));
    assert!(!requests_start_now(&envelope(json!({"text": "plain"}))));
}

/// Fork: the incognito profile on createSession is strict, and cannot ride on a worktree reservation.
#[test]
fn an_incognito_profile_is_parsed_strictly() {
    let profile = json!({
        "projectInstructions": false, "skills": false, "hooks": false, "plugins": false, "mcp": true,
        "customAgents": false, "memory": false, "outputStyle": false, "systemPromptOverrides": false,
        "identity": false, "harness": false, "environment": false, "automationTools": false,
    });
    let parse = |payload: serde_json::Value| {
        let envelope = Envelope {
            command_id: "c1".to_owned(),
            client_id: "client".to_owned(),
            session_id: None,
            base_revision: None,
            kind: "createSession".to_owned(),
            payload: payload.clone(),
            input_origin: None,
        };
        let parsed: CreateSessionPayload = serde_json::from_value(payload).unwrap();
        incognito_of(&envelope, &parsed).map_err(|ack| ack.reason_code.clone())
    };
    assert_eq!(parse(json!({"workspaceId": "/w"})), Ok(None));
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": profile})),
        Ok(Some(IncognitoProfile {
            mcp: true,
            ..IncognitoProfile::LOCKDOWN
        }))
    );
    let mut versioned = profile.clone();
    versioned["version"] = json!(1);
    let invalid = Err(Some("proto.invalidPayload".to_owned()));
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": versioned})),
        invalid
    );
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": profile, "worktreePreparation": {}})),
        invalid
    );
    // Node's `.optional()` refuses an explicit null; it must not create a normal session.
    assert_eq!(
        parse(json!({"workspaceId": "/w", "incognito": null})),
        invalid
    );
}

/// Fork: a plain createSession of an existing id never runs it under a profile its row does not hold.
#[test]
fn an_existing_session_is_never_recreated_under_another_profile() {
    let lockdown = Some(IncognitoProfile::LOCKDOWN);
    let softer = Some(IncognitoProfile {
        mcp: true,
        ..IncognitoProfile::LOCKDOWN
    });
    // A new id, and a repeat with the same profile (a persisted prewarm), go through.
    assert!(!recreate_conflict(None, lockdown));
    assert!(!recreate_conflict(None, None));
    assert!(!recreate_conflict(Some(None), None));
    assert!(!recreate_conflict(Some(lockdown), lockdown));
    // Another profile, or absent against present, is refused.
    assert!(recreate_conflict(Some(lockdown), softer));
    assert!(recreate_conflict(Some(lockdown), None));
    assert!(recreate_conflict(Some(None), lockdown));
}
