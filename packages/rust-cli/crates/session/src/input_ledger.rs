//! Fork: the session actor writes Node's `session_input` ledger (specs/fork-rust-agent-parity.md, Input ledger).
//!
//! The inbox journals each change of a queued input ([`crate::inbox::LedgerChange`]); the actor writes the journal once
//! per loop iteration, the single write path. The writes are best-effort like Node's: a failure is logged and never
//! fails the command or the turn.
use rust_cli_kernel_api::store::Fact;

use crate::actor::Actor;
use crate::inbox::LedgerChange;

impl Actor {
    /// The open sweep: a session opened from the store lost its queue with the previous process (Node
    /// `discardPersistedPendingSteerInputs`). Its `admitted` rows are settled before the first command.
    pub(crate) async fn resume_input_ledger(&mut self) {
        if !std::mem::take(&mut self.ledger_resume) {
            return;
        }
        let transcript = self.commands.values().cloned().collect();
        self.write_ledger(vec![Fact::InputsResumed { transcript }])
            .await;
    }

    /// Writes the inbox journal (called once per actor loop iteration).
    pub(crate) async fn input_ledger_sync(&mut self) {
        let facts: Vec<Fact> = self
            .inbox
            .take_journal()
            .into_iter()
            .map(|change| match change {
                LedgerChange::Admitted(input) => Fact::InputAdmitted { input },
                LedgerChange::Promoted(command) => Fact::InputPromoted { command },
                LedgerChange::Cancelled(command, reason) => Fact::InputCancelled {
                    command,
                    reason: reason.to_owned(),
                },
            })
            .collect();
        if !facts.is_empty() {
            self.write_ledger(facts).await;
        }
    }

    async fn write_ledger(&mut self, facts: Vec<Fact>) {
        if let Err(reason) = self.commit(None, facts).await {
            tracing::warn!(event = "session_input.write_failed", %reason, "the input ledger was not stored");
        }
    }
}
