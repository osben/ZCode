//! Tests of the NDJSON host (specs/fork-rust-workflow-engine.md, 4.1) against a fake child over `tokio::io::duplex`.
//! The fake writes child lines, reads the host's responses, and never runs a script.

use std::sync::Mutex as StdMutex;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};

use super::*;

/// Records what the host hands the handler, and answers asks with their instructions.
#[derive(Default)]
struct Recorder {
    created: StdMutex<Vec<String>>,
    refuse_actor: bool,
    requests: StdMutex<Vec<(String, Option<String>)>>,
    events: StdMutex<Vec<ChildEvent>>,
}

impl ChildHandler for Recorder {
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String> {
        if self.refuse_actor {
            return Err("refused".to_owned());
        }
        self.created.lock().unwrap().push(actor.local_id.clone());
        Ok(format!("engine-{}", actor.local_id))
    }

    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>> {
        self.requests
            .lock()
            .unwrap()
            .push((request.id.clone(), actor_id.clone()));
        let answer = json!({"answered": request.id, "actor": actor_id});
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
    assert_eq!(*handler.created.lock().unwrap(), vec!["local#1".to_owned()]);
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
    let outcome = host.await.unwrap();
    let Outcome::Stopped { reason, cause } = outcome else {
        panic!("expected a stop, got {outcome:?}");
    };
    assert_eq!(reason, StopReason::Interrupted);
    assert!(cause.contains("line 2"), "cause names the line: {cause}");
    // The line content never reaches the cause.
    assert!(!cause.contains("not json"));
    assert_eq!(handler.events.lock().unwrap().len(), 1);
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
async fn an_actor_the_engine_refuses_interrupts_the_run() {
    let handler = Arc::new(Recorder {
        refuse_actor: true,
        ..Recorder::default()
    });
    let (mut child, host) = start(handler);
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
    let outcome = host.await.unwrap();
    let Outcome::Stopped { reason, cause } = outcome else {
        panic!("expected a stop, got {outcome:?}");
    };
    assert_eq!(reason, StopReason::Interrupted);
    assert!(
        cause.contains("Maximum call stack"),
        "cause carries the stderr tail: {cause}"
    );
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
