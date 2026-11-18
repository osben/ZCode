//! One turn of a workflow actor, as the workflow's turn loop reads its end (W6a part 2c-2b-1; spec section 9.8e).
//!
//! Node's `executeTurn` resolves with the turn's `response` (its final text), and a turn that rejects is either cancelled
//! (silent) or a failure (`askFailed`). `spawn::drive` produces the same three cases as `Finished`: a completed run, a
//! failed run, and a killed run. [`actor_turn_end`] maps those parts to the three cases the workflow reads.

/// How an actor's turn ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActorTurnEnd {
    /// The turn completed; the text is its final text (Node's `result.response`).
    Text(String),
    /// The turn failed; the text is the failure (Node's `askFailed(toWorkflowError(error))`).
    Failed(String),
    /// The turn was stopped (cancelled or killed). Node reports nothing for a cancelled turn.
    Stopped,
}

/// Map a finished run's parts to the turn's end. A killed run is `Stopped` whatever else it carries. A failure takes
/// precedence over the text: a failed turn's text is not its result.
pub fn actor_turn_end(killed: bool, failure: Option<&str>, text: &str) -> ActorTurnEnd {
    if killed {
        return ActorTurnEnd::Stopped;
    }
    match failure {
        Some(error) => ActorTurnEnd::Failed(error.to_owned()),
        None => ActorTurnEnd::Text(text.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{ActorTurnEnd, actor_turn_end};

    #[test]
    fn a_completed_turn_is_its_final_text() {
        assert_eq!(
            actor_turn_end(false, None, "the answer"),
            ActorTurnEnd::Text("the answer".to_owned())
        );
    }

    #[test]
    fn an_empty_completed_turn_is_an_empty_text_not_a_failure() {
        assert_eq!(
            actor_turn_end(false, None, ""),
            ActorTurnEnd::Text(String::new())
        );
    }

    #[test]
    fn a_failed_turn_is_the_failure_and_its_text_is_not_the_result() {
        assert_eq!(
            actor_turn_end(false, Some("model refused"), "partial"),
            ActorTurnEnd::Failed("model refused".to_owned())
        );
    }

    #[test]
    fn a_killed_turn_is_stopped_whatever_else_it_carries() {
        assert_eq!(
            actor_turn_end(true, Some("late error"), "partial"),
            ActorTurnEnd::Stopped
        );
        assert_eq!(actor_turn_end(true, None, "partial"), ActorTurnEnd::Stopped);
    }
}
