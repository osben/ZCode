//! A fake workflow child runner (specs/fork-rust-workflow-engine.md, 9.22 W7-5a-1). It records each launch, hands the
//! test the launch's `ChildHandler` so the test can drive the child's messages, and lets the test finish the child with
//! an outcome or refuse the launch. Stopping the child settles its outcome as `Stopped(Interrupted)`, as the real
//! runner does.

use std::collections::VecDeque;
use std::sync::Arc;

use rust_cli_base::sync::LockUnpoisoned;
use serde_json::json;
use std::sync::Mutex;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::workflow_child::{
    ChildHandler, ChildStop, LaunchError, LaunchInput, Outcome, RunningChild, StopReason,
    WorkflowChildRunner,
};

/// The entry file name for a run, as the real runner writes it (`protocol-zcode`'s `workflow_entry::entry_file_name`).
/// Kept in step with that function: a test there compares the two.
pub fn entry_file_name(run_id: &str) -> String {
    let safe: String = run_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}.mjs")
}

fn panic_no_launch(index: usize, count: usize) -> ! {
    panic!("no launch {index}: the fake runner has {count} launch(es)")
}

/// One launch the fake accepted, as the test sees it.
#[derive(Clone)]
pub struct FakeLaunch {
    pub input: LaunchInput,
    /// The handler the run gave the child: the test calls it as the child would (`create_actor`, `request`, `event`).
    pub handler: Arc<dyn ChildHandler>,
}

struct Launch {
    input: LaunchInput,
    handler: Arc<dyn ChildHandler>,
    stop: CancellationToken,
    finish: Option<oneshot::Sender<Outcome>>,
}

#[derive(Default)]
struct State {
    refusals: VecDeque<LaunchError>,
    launches: Vec<Launch>,
}

/// The fake runner. Share it as `Arc<FakeChildRunner>` and pass it wherever a `WorkflowChildRunner` is taken.
#[derive(Default)]
pub struct FakeChildRunner {
    state: Mutex<State>,
}

impl FakeChildRunner {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next `start` returns this error and records no launch. Refusals are used in the order they were queued.
    pub fn refuse_next(&self, error: LaunchError) {
        self.state.lock_unpoisoned().refusals.push_back(error);
    }

    /// Every launch accepted so far, in order.
    pub fn launches(&self) -> Vec<FakeLaunch> {
        self.state
            .lock_unpoisoned()
            .launches
            .iter()
            .map(|launch| FakeLaunch {
                input: launch.input.clone(),
                handler: launch.handler.clone(),
            })
            .collect()
    }

    /// Settles the outcome of launch `index`. A second call for the same launch is ignored.
    ///
    /// Panics when no launch has that index: a test that finishes a launch it never started is wrong.
    pub fn finish(&self, index: usize, outcome: Outcome) {
        let sender = {
            let mut state = self.state.lock_unpoisoned();
            let count = state.launches.len();
            match state.launches.get_mut(index) {
                Some(launch) => launch.finish.take(),
                None => panic_no_launch(index, count),
            }
        };
        if let Some(sender) = sender {
            let _ = sender.send(outcome);
        }
    }

    /// Whether `stop` was called on launch `index`.
    ///
    /// Panics when no launch has that index.
    pub fn stop_requested(&self, index: usize) -> bool {
        let state = self.state.lock_unpoisoned();
        match state.launches.get(index) {
            Some(launch) => launch.stop.is_cancelled(),
            None => {
                let count = state.launches.len();
                drop(state);
                panic_no_launch(index, count)
            }
        }
    }
}

#[async_trait::async_trait]
impl WorkflowChildRunner for FakeChildRunner {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut state = self.state.lock_unpoisoned();
        if let Some(refusal) = state.refusals.pop_front() {
            return Err(refusal);
        }
        let index = state.launches.len();
        let stop = CancellationToken::new();
        let (sender, receiver) = oneshot::channel();
        let entry_path = input
            .cwd
            .join(".zcode")
            .join("workflow-runs")
            .join(entry_file_name(&input.run_id));
        state.launches.push(Launch {
            input,
            handler,
            stop: stop.clone(),
            finish: Some(sender),
        });
        drop(state);

        let stopped = stop.clone();
        // Biased like the real runner's `select`: a stop that is already requested wins over a finish that is ready.
        let outcome = Box::pin(async move {
            tokio::select! {
                biased;
                _ = stopped.cancelled() => Outcome::Stopped {
                    reason: StopReason::Interrupted,
                    cause: "the fake child was stopped".to_owned(),
                },
                settled = receiver => match settled {
                    Ok(outcome) => outcome,
                    Err(_) => Outcome::Stopped {
                        reason: StopReason::Interrupted,
                        cause: "the fake child was dropped before it finished".to_owned(),
                    },
                },
            }
        });
        Ok(RunningChild {
            script_hash: format!("fake-{index}"),
            compiled: json!({}),
            entry_path,
            entry_fallback: false,
            stop: ChildStop::new(stop),
            outcome,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use futures_util::future::BoxFuture;
    use serde_json::Value;

    use super::*;
    use crate::workflow_child::{ChildEvent, ChildRequest, Completion, CreateActor, WireError};

    struct Idle;

    impl ChildHandler for Idle {
        fn create_actor(&self, actor: &CreateActor) -> BoxFuture<'static, Result<String, String>> {
            let id = format!("engine-{}", actor.local_id);
            Box::pin(async move { Ok(id) })
        }

        fn request(
            &self,
            _request: ChildRequest,
            _actor_id: Option<String>,
        ) -> BoxFuture<'static, Result<Value, WireError>> {
            Box::pin(async { Ok(Value::Null) })
        }

        fn event(&self, _event: ChildEvent) {}
    }

    fn input(run_id: &str) -> LaunchInput {
        LaunchInput {
            script_text: "export default 1;".to_owned(),
            run_id: run_id.to_owned(),
            args: None,
            resumed_from: None,
            cwd: PathBuf::from("/work/project"),
        }
    }

    #[tokio::test]
    async fn a_launch_is_recorded_with_its_input_and_the_handler_the_test_drives() {
        let runner = FakeChildRunner::new();
        let _running = runner
            .start(input("run-1"), Arc::new(Idle))
            .await
            .expect("accepted");
        let launches = runner.launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].input, input("run-1"));
        let engine_id = launches[0]
            .handler
            .create_actor(&CreateActor {
                local_id: "a1".to_owned(),
                site_id: "s".to_owned(),
                name: None,
                persona: None,
            })
            .await
            .expect("the handler answers");
        assert_eq!(engine_id, "engine-a1");
    }

    #[tokio::test]
    async fn a_refused_launch_returns_its_error_and_records_nothing() {
        let runner = FakeChildRunner::new();
        runner.refuse_next(LaunchError::Failed("the helper is down".to_owned()));
        let refused = runner.start(input("run-1"), Arc::new(Idle)).await;
        assert!(
            matches!(refused, Err(LaunchError::Failed(ref text)) if text == "the helper is down")
        );
        assert!(runner.launches().is_empty());
        // The refusal was used once: the next launch is accepted.
        assert!(runner.start(input("run-2"), Arc::new(Idle)).await.is_ok());
        assert_eq!(runner.launches().len(), 1);
    }

    #[tokio::test]
    async fn finishing_a_launch_settles_its_outcome_once() {
        let runner = FakeChildRunner::new();
        let running = runner
            .start(input("run-1"), Arc::new(Idle))
            .await
            .expect("accepted");
        let done = Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        });
        runner.finish(0, done.clone());
        runner.finish(
            0,
            Outcome::Stopped {
                reason: StopReason::Interrupted,
                cause: "too late".to_owned(),
            },
        );
        assert_eq!((running.outcome).await, done);
    }

    #[tokio::test]
    #[should_panic(expected = "no launch 1: the fake runner has 1 launch(es)")]
    async fn finishing_a_launch_that_does_not_exist_panics_with_the_index_and_count() {
        let runner = FakeChildRunner::new();
        let _running = runner
            .start(input("run-1"), Arc::new(Idle))
            .await
            .expect("accepted");
        runner.finish(
            1,
            Outcome::Completed(Completion {
                ok: true,
                value: None,
                error: None,
            }),
        );
    }

    #[tokio::test]
    #[should_panic(expected = "no launch 3: the fake runner has 0 launch(es)")]
    async fn asking_about_a_stop_of_a_launch_that_does_not_exist_panics() {
        let runner = FakeChildRunner::new();
        runner.stop_requested(3);
    }

    #[tokio::test]
    async fn the_entry_file_name_is_sanitised_like_the_real_runner() {
        let runner = FakeChildRunner::new();
        let running = runner
            .start(input("a/../b c"), Arc::new(Idle))
            .await
            .expect("accepted");
        assert_eq!(
            running.entry_path,
            PathBuf::from("/work/project/.zcode/workflow-runs/a_.._b_c.mjs")
        );
        assert_eq!(entry_file_name("a/../b c"), "a_.._b_c.mjs");
        assert_eq!(entry_file_name("run-1.a_b"), "run-1.a_b.mjs");
    }

    #[tokio::test]
    async fn a_stop_wins_over_a_finish_that_is_already_ready() {
        for _ in 0..50 {
            let runner = FakeChildRunner::new();
            let running = runner
                .start(input("run-1"), Arc::new(Idle))
                .await
                .expect("accepted");
            runner.finish(
                0,
                Outcome::Completed(Completion {
                    ok: true,
                    value: None,
                    error: None,
                }),
            );
            running.stop.stop();
            assert!(matches!(
                (running.outcome).await,
                Outcome::Stopped {
                    reason: StopReason::Interrupted,
                    ..
                }
            ));
        }
    }

    #[tokio::test]
    async fn stopping_a_launch_settles_it_as_interrupted_and_is_recorded() {
        let runner = FakeChildRunner::new();
        let running = runner
            .start(input("run-1"), Arc::new(Idle))
            .await
            .expect("accepted");
        assert!(!running.stop.is_stopped());
        assert!(!runner.stop_requested(0));
        running.stop.stop();
        assert!(runner.stop_requested(0));
        assert!(matches!(
            (running.outcome).await,
            Outcome::Stopped {
                reason: StopReason::Interrupted,
                ..
            }
        ));
    }
}
