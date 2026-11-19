//! The Node driver tests of `bootstrap/tests/workflow-driver.test.ts`, `workflow-driver-submit-profile.test.ts` and
//! `workflow-escalation.test.ts` that the Rust driver owner can run without a model or a transcript store (spec
//! section 9.8i lists every case and where each one lives). Each test names the Node case it ports.
//!
//! The owner's turn side is the `Recording` double of `driver_owner_tests`; the turn runtime is not involved.
use crate::driver_owner::SubmitReply;
use crate::driver_owner_tests::{owner, request, running_ask};
use crate::driver_rules::{SubmitProfile, quality_epilogue};
use crate::engine::SubmitVerdict;
use crate::escalation::{AnswerOutcome, EscalateOutcome};
use crate::journal::{JournalPort, MemoryJournal};
use crate::model::Ref;
use rust_cli_node_store::mint_actor_session_id;
use serde_json::{Value, json};

/// The instance of the first turn the recorder saw (the ask that `running_ask` started).
fn first_instance(sessions: &crate::driver_owner_tests::Recording) -> Ref {
    sessions.0.borrow().turns[0].1.clone()
}

/// Node `workflow-driver.test.ts` "lenient stringified submit": a result sent as the JSON text of an object is
/// accepted, and the journal holds the parsed object, not the string.
#[test]
fn a_stringified_submit_is_accepted_and_journaled_as_the_parsed_object() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let artifact = json!({"ok": true});
    let reply = owner
        .submit_result(&session, Value::String(artifact.to_string()))
        .expect("submit");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
    let outcomes = owner.take_outcomes();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].result, Ok(artifact.clone()));
    let node = owner
        .journal()
        .get_node("run_1", &first_instance(&sessions))
        .expect("read")
        .expect("the ask node");
    assert_eq!(node.result, Some(artifact));
}

/// Node `workflow-driver.test.ts` "会话 id 含 runId 且不含 # @ /": the minted id carries the run id and no separator.
#[test]
fn a_session_id_carries_the_run_id_and_no_separator() {
    let id = mint_actor_session_id("dwfrun-plain", "actor#1", 1.0);
    assert!(id.contains("dwfrun-plain"), "{id}");
    assert!(!id.contains(['#', '@', '/']), "{id}");
}

/// Node "下划线转义使 sanitize 可逆到不碰撞": `a_b` and `a#b` mint different ids, and the escape shows as `__`.
#[test]
fn an_underscore_in_a_run_id_does_not_collide_with_a_hash() {
    let underscore = mint_actor_session_id("a_b", "actor#1", 1.0);
    let hash = mint_actor_session_id("a#b", "actor#1", 1.0);
    assert_ne!(underscore, hash);
    assert!(underscore.contains("a__b"), "{underscore}");
    assert!(hash.contains("a_b"), "{hash}");
}

/// Node "对抗性对子逐对不碰撞": each pair of adversarial names mints two different, charset-safe ids.
#[test]
fn adversarial_name_pairs_mint_distinct_charset_safe_ids() {
    let pairs: [(&str, &str); 3] = [
        ("actor#1", "actor_1"),
        ("actor#1@2", "actor_1@2"),
        ("ask#3/2", "ask_3_2"),
    ];
    for (left, right) in pairs {
        let left_id = mint_actor_session_id(left, "w", 1.0);
        let right_id = mint_actor_session_id(right, "w", 1.0);
        assert_ne!(left_id, right_id, "{left} vs {right}");
        assert!(!left_id.contains(['#', '@', '/']), "{left_id}");
        assert!(!right_id.contains(['#', '@', '/']), "{right_id}");
    }
}

/// Node "无转录存取面时不写边界": with nothing reporting a message count, a settled ask keeps no boundary. Absent
/// means absent; the owner never writes 0 or a guess.
#[test]
fn an_ask_with_no_reported_boundary_keeps_none() {
    let (mut owner, sessions, _actor, session) = running_ask();
    owner
        .submit_result(&session, json!({"ok": true}))
        .expect("submit");
    let node = owner
        .journal()
        .get_node("run_1", &first_instance(&sessions))
        .expect("read")
        .expect("the ask node");
    assert_eq!(node.message_boundary, None);
}

/// Node "untyped ask: instructions then the standard, no schema epilogue": the untyped input is the instructions and
/// the quality standard, and no schema text.
#[test]
fn an_untyped_ask_input_is_the_instructions_then_the_standard_only() {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("plain", None, None).expect("actor");
    owner.ask("plain", &actor, "What is 2 + 2?").expect("ask");
    owner.drain().expect("drain");
    let log = sessions.0.borrow();
    let expected = format!("What is 2 + 2?{}", quality_epilogue(None));
    assert_eq!(
        log.inputs[0],
        (expected.clone(), "What is 2 + 2?".encode_utf16().count())
    );
    assert!(!expected.contains("(any JSON value)"));
}

/// Node "untyped-only subagent gets no submit_result at all": an untyped profile declares no schema on the turn.
#[test]
fn an_untyped_profile_declares_no_submit_schema_on_its_turn() {
    let (mut owner, sessions) = owner();
    let actor = owner.create_actor("plain", None, None).expect("actor");
    owner.set_actor_profile(&actor, SubmitProfile::Untyped);
    owner.ask("plain", &actor, "say hi").expect("ask");
    owner.drain().expect("drain");
    let log = sessions.0.borrow();
    assert_eq!(log.submit_schemas, vec![None]);
    assert!(!log.inputs[0].0.contains("submit_result"));
}

/// Node "names the evidence and confidence fields when the schema declares them": the quality standard adds the
/// two lines only for a schema that declares those fields.
#[test]
fn a_schema_declaring_evidence_and_confidence_gets_their_standard_lines() {
    let schema = json!({
        "type": "object",
        "properties": {
            "where": {"type": "string"},
            "evidence": {"type": "string"},
            "confidence": {"type": "number"}
        }
    });
    let text = quality_epilogue(Some(&schema));
    assert!(
        text.contains("Put each finding's citation in its `evidence` field."),
        "{text}"
    );
    assert!(text.contains("Rate `confidence` honestly"), "{text}");
    let plain = quality_epilogue(Some(
        &json!({"type": "object", "properties": {"where": {"type": "string"}}}),
    ));
    assert!(!plain.contains("`evidence` field"), "{plain}");
    assert!(!plain.contains("Rate `confidence`"), "{plain}");
}

/// Node "escalation: raised and resolved both reach the journal in order": the raise is journaled before the
/// resolve, and each carries the question id the answer uses.
#[test]
fn an_escalation_raise_and_its_answer_are_journaled_in_that_order() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let parked = match owner
        .escalate(&session, request("which file?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a parked question, got {other:?}"),
    };
    let answered: Option<AnswerOutcome> = owner.answer(&parked, "a.ts").expect("answer");
    assert_eq!(
        answered.map(|outcome| outcome.answer),
        Some("a.ts".to_owned())
    );
    let kinds: Vec<(String, String)> = owner
        .events()
        .expect("events")
        .into_iter()
        .filter_map(|stored| {
            let event: Value = serde_json::from_str(&stored.payload_json).expect("json");
            let kind = event["type"].as_str()?.to_owned();
            matches!(kind.as_str(), "escalation-raised" | "escalation-resolved")
                .then(|| (kind, event["qid"].as_str().unwrap_or_default().to_owned()))
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("escalation-raised".to_owned(), parked.clone()),
            ("escalation-resolved".to_owned(), parked),
        ]
    );
}

/// Node `workflow-driver.test.ts` "resume 会话身份互证": a journal row whose session id is not the minted one
/// fails the actor with a structured mismatch before any session is created. The scheduler checks the recorded id
/// before it calls the driver, as Node checks it before the factory.
#[test]
fn a_journal_session_id_that_is_not_the_minted_one_fails_before_a_session_is_created() {
    use crate::driver_owner::ActorDriverOwner;
    use crate::driver_owner_tests::{Recording, config};
    use crate::model::{ActorRow, RunRow, RunStatus};

    let sessions = Recording::default();
    let mut journal = MemoryJournal::new();
    journal
        .create_run(RunRow {
            run_id: "run_1".into(),
            parent_session_id: Some("ses_parent".into()),
            cwd: None,
            name: None,
            tool_call_id: None,
            script_text: None,
            script_hash: None,
            args: None,
            resumed_from: None,
            caps: config().caps,
            spent_tokens: 0.0,
            status: RunStatus::Running,
            stop_reason: None,
            superseded_by: None,
            failure: None,
            result: None,
        })
        .expect("the run row");
    journal
        .put_actor(ActorRow {
            run_id: "run_1".into(),
            site_id: "site".into(),
            ordinal: 1,
            name: None,
            persona: None,
            session_id: Some("sess_drifted-scheme".into()),
            resolved_model: None,
        })
        .expect("seed the actor row");
    let mut owner = ActorDriverOwner::new(config(), journal, sessions.clone()).expect("owner");
    let actor = owner.create_actor("site", None, None).expect("actor");
    owner.ask("site", &actor, "do it").expect("ask");
    owner.drain().expect("drain");
    assert!(
        sessions.0.borrow().created.is_empty(),
        "no session may be created for a drifted journal id"
    );
    let outcomes = owner.take_outcomes();
    let error = outcomes[0].result.as_ref().expect_err("the ask fails");
    assert_eq!(error.code, crate::error::ErrorCode::DriverError);
    let mismatch = error.mismatch.as_ref().expect("a structured mismatch");
    assert_eq!(mismatch.expected, "sess_drifted-scheme");
    assert_eq!(
        mismatch.got,
        rust_cli_node_store::mint_actor_session_id("run_1", "site", 1.0)
    );
}
