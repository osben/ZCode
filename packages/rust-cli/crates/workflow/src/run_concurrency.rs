//! The process-level governor, as one run's owner sees it (Node `WorkflowConcurrencyPort`, the part a run uses).
//!
//! The workflow crate does not depend on the model crate, so the governor is reached through this port. The model
//! crate's governor implements it in production (the run service wires it); until then the owner runs ungoverned, as
//! Node does without a governor. The port carries workflow data only: a bound is a count and a change is a
//! [`ConcurrencyChange`].
use crate::model::ConcurrencyChange;

/// A run's listener for cap changes on the keys it is engaged on. It is called on the governor's thread, so it must not
/// touch the engine; the owner's listener posts the change to the owner's mailbox instead.
pub type ConcurrencyListener = Box<dyn Fn(&ConcurrencyChange) + Send + Sync>;

pub trait RunConcurrency: Send + Sync {
    /// Node `setRunBound`: the run's own concurrency bound. The governor raises the growth limit of the keys the run
    /// has used to at least this bound.
    fn set_run_bound(&self, run_id: &str, bound: u64);

    /// Node `clearRunBound`: the run no longer bounds the governor's limits (its run ended).
    fn clear_run_bound(&self, run_id: &str);

    /// Node `subscribe`: the listener hears each cap change on a key the run is engaged on. The returned function
    /// ends the subscription (Node's unsubscribe).
    fn subscribe(&self, run_id: &str, listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send>;
}
