//! Tests of the NDJSON host (specs/fork-rust-workflow-engine.md, 4.1) against a fake child over `tokio::io::duplex`.
//! The fake writes child lines, reads the host's responses, and never runs a script.

use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::super::workflow_wire::RequestType;
use super::*;

/// Records what the host hands the handler, and answers asks with their instructions.
#[derive(Default)]
struct Recorder {
    created: StdMutex<Vec<CreateActor>>,
    refuse_actor: Option<String>,
    requests: StdMutex<Vec<(ChildRequest, Option<String>)>>,
    events: StdMutex<Vec<ChildEvent>>,
}

impl ChildHandler for Recorder {
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String> {
        if let Some(reason) = &self.refuse_actor {
            return Err(reason.clone());
        }
        self.created.lock().unwrap().push(actor.clone());
        Ok(format!("engine-{}", actor.local_id))
    }

    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>> {
        let answer = json!({"answered": request.id, "actor": actor_id});
        self.requests.lock().unwrap().push((request, actor_id));
        Box::pin(async move { Ok(answer) })
    }

    fn event(&self, event: ChildEvent) {
        self.events.lock().unwrap().push(event);
    }
}

/// The test side of one child: writes its stdout, reads the host's stdin, writes its stderr.
struct FakeChild {
    stdout: DuplexStream,
    answers: Lines<BufReader<DuplexStream>>,
    stderr: DuplexStream,
}

fn start(handler: Arc<Recorder>) -> (FakeChild, tokio::task::JoinHandle<Outcome>) {
    let (child_stdout, host_stdout) = duplex(1 << 16);
    let (host_stdin, child_stdin) = duplex(1 << 16);
    let (child_stderr, host_stderr) = duplex(1 << 16);
    let io = ChildIo {
        stdout: BufReader::new(host_stdout),
        stdin: host_stdin,
        stderr: host_stderr,
    };
    let host = tokio::spawn(run(io, handler));
    (
        FakeChild {
            stdout: child_stdout,
            answers: BufReader::new(child_stdin).lines(),
            stderr: child_stderr,
        },
        host,
    )
}

impl FakeChild {
    async fn send(&mut self, line: Value) {
        self.stdout
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn raw(&mut self, text: &str) {
        self.stdout.write_all(text.as_bytes()).await.unwrap();
    }

    async fn answer(&mut self) -> Value {
        let line = self
            .answers
            .next_line()
            .await
            .unwrap()
            .expect("a response line");
        serde_json::from_str(&line).unwrap()
    }
}

fn stop_cause(outcome: Outcome) -> String {
    let Outcome::Stopped { reason, cause } = outcome else {
        panic!("expected a stop, got {outcome:?}");
    };
    assert_eq!(reason, StopReason::Interrupted);
    cause
}

#[tokio::test]
async fn a_complete_line_ends_the_run_with_its_value() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child
        .send(json!({"kind": "complete", "ok": true, "value": "done"}))
        .await;
    let outcome = host.await.unwrap();
    assert_eq!(
        outcome,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        })
    );
}

#[tokio::test]
async fn events_are_handled_in_line_order_and_answer_nothing() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child
        .send(json!({"kind": "event", "type": "phase-entered", "name": "review"}))
        .await;
    child
        .send(json!({"kind": "event", "type": "log", "message": "one"}))
        .await;
    child.send(json!({"kind": "event", "type": "report", "siteId": "s1", "item": {"n": 1}, "artifactId": "perf"})).await;
    child.send(json!({"kind": "event", "type": "declare-artifact", "siteId": "s2", "op": "chart", "args": ["id", {}]})).await;
    child.send(json!({"kind": "complete", "ok": true})).await;
    assert!(matches!(host.await.unwrap(), Outcome::Completed(_)));
    assert_eq!(
        *handler.events.lock().unwrap(),
        vec![
            ChildEvent::PhaseEntered {
                name: "review".to_owned()
            },
            ChildEvent::Log {
                message: "one".to_owned()
            },
            ChildEvent::Report {
                site_id: "s1".to_owned(),
                item: json!({"n": 1}),
                artifact_id: Some("perf".to_owned()),
            },
            ChildEvent::DeclareArtifact {
                site_id: "s2".to_owned(),
                op: "chart".to_owned(),
                args: vec![json!("id"), json!({})],
            },
        ]
    );
}

#[tokio::test]
async fn create_actor_maps_the_local_handle_before_a_request_names_it() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child.send(json!({"kind": "create-actor", "localId": "local#1", "siteId": "s1", "name": "reviewer"})).await;
    child.send(json!({"kind": "request", "id": "r1", "type": "ask", "siteId": "s1", "actor": "local#1", "instructions": "go"})).await;
    let answer = child.answer().await;
    assert_eq!(answer["kind"], "response");
    assert_eq!(answer["id"], "r1");
    assert_eq!(answer["ok"], true);
    assert_eq!(
        answer["value"],
        json!({"answered": "r1", "actor": "engine-local#1"})
    );
    child.send(json!({"kind": "complete", "ok": true})).await;
    host.await.unwrap();
    let created = handler.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].local_id, "local#1");
    assert_eq!(created[0].name.as_deref(), Some("reviewer"));
}

#[tokio::test]
async fn an_ask_carries_every_optional_field_it_was_sent_with() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child
        .send(json!({
            "kind": "create-actor",
            "localId": "local#2",
            "siteId": "s1",
            "name": "reviewer",
            "persona": {"role": "auditor"},
        }))
        .await;
    child
        .send(json!({
            "kind": "request",
            "id": "r2",
            "type": "ask",
            "siteId": "s1",
            "actor": "local#2",
            "instructions": "check the diff",
        }))
        .await;
    child
        .send(json!({
            "kind": "request",
            "id": "r3",
            "type": "world-read",
            "siteId": "s2",
            "op": "files.grep",
            "args": ["TODO", "*.ts"],
        }))
        .await;
    child
        .send(json!({
            "kind": "request",
            "id": "r4",
            "type": "publish-artifact",
            "siteId": "s3",
            "artifactOp": "file",
            "args": ["id", {"path": "a.md"}],
        }))
        .await;
    child
        .send(json!({
            "kind": "request",
            "id": "r5",
            "type": "hole",
            "siteId": "s4",
            "name": "fill-me",
            "prompt": "Explain the cache",
        }))
        .await;
    for _ in 0..4 {
        child.answer().await;
    }
    child.send(json!({"kind": "complete", "ok": true})).await;
    host.await.unwrap();

    let created = handler.created.lock().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].persona, Some(json!({"role": "auditor"})));
    drop(created);
    let requests = handler.requests.lock().unwrap();
    let by_id = |id: &str| {
        requests
            .iter()
            .find(|(request, _)| request.id == id)
            .map(|(request, actor)| (request.clone(), actor.clone()))
            .unwrap_or_else(|| panic!("request {id} reached the handler"))
    };
    let (ask, actor) = by_id("r2");
    assert_eq!(ask.request_type, RequestType::Ask);
    assert_eq!(ask.instructions.as_deref(), Some("check the diff"));
    assert_eq!(actor.as_deref(), Some("engine-local#2"));
    let (read, _) = by_id("r3");
    assert_eq!(read.request_type, RequestType::WorldRead);
    assert_eq!(read.op.as_deref(), Some("files.grep"));
    assert_eq!(read.args, Some(vec![json!("TODO"), json!("*.ts")]));
    let (publish, _) = by_id("r4");
    assert_eq!(publish.request_type, RequestType::PublishArtifact);
    assert_eq!(publish.artifact_op.as_deref(), Some("file"));
    assert_eq!(
        publish.args,
        Some(vec![json!("id"), json!({"path": "a.md"})])
    );
    let (hole, _) = by_id("r5");
    assert_eq!(hole.request_type, RequestType::Hole);
    assert_eq!(hole.name.as_deref(), Some("fill-me"));
    assert_eq!(hole.prompt.as_deref(), Some("Explain the cache"));
}

#[tokio::test]
async fn every_pending_request_gets_its_own_response() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child.send(json!({"kind": "request", "id": "a", "type": "world-read", "siteId": "s1", "op": "git.status", "args": []})).await;
    child
        .send(json!({"kind": "request", "id": "b", "type": "hole", "siteId": "s2", "name": "h"}))
        .await;
    let mut ids = vec![child.answer().await["id"].as_str().unwrap().to_owned()];
    ids.push(child.answer().await["id"].as_str().unwrap().to_owned());
    ids.sort();
    assert_eq!(ids, vec!["a".to_owned(), "b".to_owned()]);
    child.send(json!({"kind": "complete", "ok": true})).await;
    host.await.unwrap();
}

#[tokio::test]
async fn a_malformed_line_interrupts_the_run_and_nothing_after_it_is_handled() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child
        .send(json!({"kind": "event", "type": "log", "message": "before"}))
        .await;
    child.raw("{not json\n").await;
    child
        .send(json!({"kind": "event", "type": "log", "message": "after"}))
        .await;
    let cause = stop_cause(host.await.unwrap());
    assert!(cause.contains("line 2"), "cause names the line: {cause}");
    // The line content never reaches the cause.
    assert!(!cause.contains("not json"));
    assert_eq!(handler.events.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn whitespace_only_lines_are_skipped_as_the_reference_host_skips_them() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child.raw("\n   \r\n\t\n").await;
    child
        .send(json!({"kind": "event", "type": "log", "message": "after blanks"}))
        .await;
    child.send(json!({"kind": "complete", "ok": true})).await;
    assert!(matches!(host.await.unwrap(), Outcome::Completed(_)));
    assert_eq!(
        *handler.events.lock().unwrap(),
        vec![ChildEvent::Log {
            message: "after blanks".to_owned()
        }]
    );
}

#[tokio::test]
async fn a_line_split_across_writes_is_read_whole() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child.raw(r#"{"kind":"event","#).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    child.raw(r#""type":"log","message":"split"}"#).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    child.raw("\n").await;
    child.send(json!({"kind": "complete", "ok": true})).await;
    assert!(matches!(host.await.unwrap(), Outcome::Completed(_)));
    assert_eq!(
        *handler.events.lock().unwrap(),
        vec![ChildEvent::Log {
            message: "split".to_owned()
        }]
    );
}

#[tokio::test]
async fn a_line_over_the_cap_stops_the_run_without_handling_it() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    let oversized = "x".repeat(MAX_LINE_BYTES + 1);
    // The host stops reading at the cap, so the rest of the line is never read: the write may be cut short.
    let _ = child.stdout.write_all(oversized.as_bytes()).await;
    let _ = child.stdout.write_all(b"\n").await;
    let cause = stop_cause(host.await.unwrap());
    assert!(cause.contains("line 1"), "cause names the line: {cause}");
    assert!(handler.events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unknown_kind_or_a_response_from_the_child_interrupts_the_run() {
    for line in [
        json!({"kind": "shout", "message": "x"}),
        json!({"kind": "response", "id": "r1", "ok": true}),
    ] {
        let handler = Arc::new(Recorder::default());
        let (mut child, host) = start(handler);
        child.send(line).await;
        assert!(matches!(
            host.await.unwrap(),
            Outcome::Stopped {
                reason: StopReason::Interrupted,
                ..
            }
        ));
    }
}

#[tokio::test]
async fn a_request_naming_an_actor_the_child_never_created_interrupts_the_run() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler.clone());
    child.send(json!({"kind": "request", "id": "r1", "type": "ask", "siteId": "s1", "actor": "local#9", "instructions": "go"})).await;
    assert!(matches!(
        host.await.unwrap(),
        Outcome::Stopped {
            reason: StopReason::Interrupted,
            ..
        }
    ));
    assert!(handler.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_repeated_local_handle_interrupts_the_run() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler);
    child
        .send(json!({"kind": "create-actor", "localId": "local#1", "siteId": "s1"}))
        .await;
    child
        .send(json!({"kind": "create-actor", "localId": "local#1", "siteId": "s1"}))
        .await;
    assert!(matches!(
        host.await.unwrap(),
        Outcome::Stopped {
            reason: StopReason::Interrupted,
            ..
        }
    ));
}

#[tokio::test]
async fn an_actor_the_engine_refuses_interrupts_the_run_and_carries_the_reason() {
    let handler = Arc::new(Recorder {
        refuse_actor: Some("site s1 is not an actor site".to_owned()),
        ..Recorder::default()
    });
    let (mut child, host) = start(handler);
    child
        .send(json!({"kind": "create-actor", "localId": "local#1", "siteId": "s1"}))
        .await;
    let cause = stop_cause(host.await.unwrap());
    assert!(
        cause.contains("site s1 is not an actor site"),
        "cause carries the refusal: {cause}"
    );
}

#[tokio::test]
async fn an_early_exit_interrupts_the_run_and_names_the_stderr_tail() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler);
    child
        .stderr
        .write_all(b"RangeError: Maximum call stack size exceeded")
        .await
        .unwrap();
    child
        .send(json!({"kind": "event", "type": "log", "message": "partial"}))
        .await;
    // Dropping the child's ends is the exit: EOF on its stdout and stderr.
    drop(child);
    let cause = stop_cause(host.await.unwrap());
    assert!(
        cause.contains("Maximum call stack"),
        "cause carries the stderr tail: {cause}"
    );
}

#[tokio::test]
async fn a_stderr_that_never_closes_does_not_hold_the_stop_up() {
    let handler = Arc::new(Recorder::default());
    let (child, host) = start(handler);
    let FakeChild {
        stdout,
        answers: _,
        mut stderr,
    } = child;
    // A grandchild keeps stderr open and trickles bytes faster than any per-read timeout would catch.
    let trickle = tokio::spawn(async move {
        loop {
            if stderr.write_all(b".").await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    drop(stdout);
    let outcome = tokio::time::timeout(Duration::from_secs(5), host)
        .await
        .expect("the stop is bounded by the drain deadline, not by the writer's pace")
        .unwrap();
    assert!(matches!(
        outcome,
        Outcome::Stopped {
            reason: StopReason::Interrupted,
            ..
        }
    ));
    trickle.abort();
}

#[tokio::test]
async fn a_final_line_without_a_newline_is_read_as_a_line_like_readline_does() {
    let handler = Arc::new(Recorder::default());
    let (mut child, host) = start(handler);
    child
        .raw(r#"{"kind":"complete","ok":false,"error":{"name":"Error","message":"boom"}}"#)
        .await;
    drop(child.stdout);
    let outcome = host.await.unwrap();
    let Outcome::Completed(completion) = outcome else {
        panic!("expected completion, got {outcome:?}");
    };
    assert!(!completion.ok);
    assert_eq!(completion.error.unwrap().message, "boom");
}

/// The host decodes each child line as `ChildMessage` (`take_line`). A float in a line must come out as
/// the nearest double, as `JSON.parse` gives it (`123456789012345680000` is one ulp off with serde's
/// default parser). The number travels in a report item, the only child event that carries a free value.
#[test]
fn a_number_in_a_child_line_is_the_nearest_double() {
    let line = r#"{"kind":"event","type":"report","siteId":"s","item":123456789012345680000}"#;
    let message: ChildMessage = serde_json::from_str(line).expect("the host's decode path");
    let ChildMessage::Event(ChildEvent::Report { item, .. }) = message else {
        panic!("expected a report event");
    };
    assert_eq!(item.as_f64(), Some(123456789012345680000.0));
}
