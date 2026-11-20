//! A fake workflow child runner (specs/fork-rust-workflow-engine.md, 9.22 W7-5a-1). It records each launch, hands the
//! test the launch's `ChildHandler` so the test can drive the child's messages, and lets the test finish the child with
//! an outcome or refuse the launch. Stopping the child settles its outcome as `Stopped(Interrupted)`, as the real
//! runner does.

use std::collections::VecDeque;
use std::sync::Arc;

use futures_util::future::{Either, select};
use rust_cli_base::sync::LockUnpoisoned;
use serde_json::json;
use std::sync::Mutex;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::workflow_child::{
    ChildHandler, ChildStop, LaunchError, LaunchInput, Outcome, RunningChild, StopReason,
    WorkflowChildRunner,
};

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
    pub fn finish(&self, index: usize, outcome: Outcome) {
        if let Some(sender) = self
            .state
            .lock_unpoisoned()
            .launches
            .get_mut(index)
            .and_then(|launch| launch.finish.take())
        {
            let _ = sender.send(outcome);
        }
    }

    /// Whether `stop` was called on launch `index`.
    pub fn stop_requested(&self, index: usize) -> bool {
        self.state
            .lock_unpoisoned()
            .launches
            .get(index)
            .is_some_and(|launch| launch.stop.is_cancelled())
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
            .join(format!("{}.mjs", input.run_id));
        state.launches.push(Launch {
            input,
            handler,
            stop: stop.clone(),
            finish: Some(sender),
        });
        drop(state);

        let stopped = stop.clone();
        let outcome = Box::pin(async move {
            match select(Box::pin(stopped.cancelled()), receiver).await {
                Either::Left(_) => Outcome::Stopped {
                    reason: StopReason::Interrupted,
                    cause: "the fake child was stopped".to_owned(),
                },
                Either::Right((Ok(outcome), _)) => outcome,
                Either::Right((Err(_), _)) => Outcome::Stopped {
                    reason: StopReason::Interrupted,
                    cause: "the fake child was dropped before it finished".to_owned(),
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
        fn create_actor(&self, actor: &CreateActor) -> Result<String, String> {
            Ok(format!("engine-{}", actor.local_id))
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
