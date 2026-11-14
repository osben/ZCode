//! Fork: the session configuration of an ACP agent (specs/fork-rust-agent-parity.md "ACP external agents", rules 13
//! and 16; Node `acp-config-reconcile.ts` and the `config_options` arm of `acp-external-agent-host.ts`).
//!
//! The command handler owns the choices; the turn only reads them. Before each prompt the turn applies the choices
//! the agent still offers, keeps the agent's handshake offer in the catalog and, when the agent's options differ from
//! the stored display copy, stores and emits them. An agent-initiated change during the prompt is stored and emitted
//! the same way; the choices stay as they are.

use async_trait::async_trait;
use rust_cli_acp::{AcpRuntime, ConfigOption};
use rust_cli_kernel_api::external_agent_config::{
    ExternalAgentConfigOption, ExternalAgentConfigs, options_from_json, options_to_json,
};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::orchestration::{QueryEvent, RunSink};
use rust_cli_kernel_api::store::{AcpSessionConfig, StoreError};

use super::AcpHost;

/// Node `toExternalAgentConfig`: the runtime snapshot in the contract shape.
pub(super) fn to_contract(options: &[ConfigOption]) -> Vec<ExternalAgentConfigOption> {
    options_from_json(&rust_cli_acp::config::options_to_json(options)).unwrap_or_default()
}

/// Why the reconcile stopped the turn.
pub(super) enum ReconcileError {
    /// The agent refused a chosen value: Node's `ExternalAgentTurnError("prompt_failed")` text.
    Refused(String),
    Store(StoreError),
}

impl AcpHost {
    /// Node `reconcileAcpSessionConfig`.
    pub(super) async fn reconcile_config(
        &self,
        runtime: &AcpRuntime,
        session: &SessionId,
        agent: &str,
        sink: &dyn RunSink,
    ) -> Result<(), ReconcileError> {
        let stored = self
            .store
            .acp_config(session)
            .await
            .map_err(ReconcileError::Store)?;
        let current = to_contract(&runtime.config_options());
        for (config_id, value) in &stored.choices {
            let Some(option) = current
                .iter()
                .find(|option| option.id == *config_id && option.offers(value))
            else {
                // Values are never logged: a choice can name a model the user picked.
                tracing::debug!(event = "acp.config_dropped", agent, config_id = %config_id, "ACP agent config choice dropped");
                continue;
            };
            if option.current_value == *value {
                continue;
            }
            if let Err(error) = runtime.set_config_option(config_id, value).await {
                return Err(ReconcileError::Refused(format!(
                    "Could not set {} to {}: {}",
                    option.name,
                    option.value_name(value),
                    error.message
                )));
            }
        }
        let snapshot = to_contract(&runtime.config_options());
        // The catalog is the agent's offer. The values applied above belong to this session: a new draft would
        // otherwise show another session's choice as the default.
        let offered = to_contract(&runtime.handshake_config_options());
        if !offered.is_empty()
            && let Err(error) = self
                .catalog
                .write(agent, &offered, self.clock.now_ms())
                .await
        {
            // The catalog only feeds the composer before the first turn; the turn itself goes on.
            tracing::warn!(event = "acp.catalog_store_failed", agent, %error, "ACP agent catalog could not be stored");
        }
        // An agent without options and a session without a stored copy have nothing to show.
        if stored.offered.is_none() && snapshot.is_empty() {
            return Ok(());
        }
        // Node compares the canonical JSON: a stored copy without an optional field equals one with `null`.
        if stored.offered.as_ref().and_then(options_from_json).as_ref() == Some(&snapshot) {
            return Ok(());
        }
        match self
            .store
            .set_acp_offered(session, &options_to_json(&snapshot))
            .await
        {
            Ok(()) => {}
            // Rule 15: without Node's fork ACP tables there is no binding to hold the copy; the turn goes on and shows
            // the options unstored, as the binding write lets the turn go on. Node always has the tables.
            Err(StoreError::Unsupported { .. }) => {
                tracing::debug!(
                    event = "acp.config_unstored",
                    agent,
                    "ACP agent options shown without the fork tables"
                );
            }
            Err(error) => return Err(ReconcileError::Store(error)),
        }
        emit(sink, agent, snapshot).await;
        Ok(())
    }

    /// An agent-initiated change during the prompt: the display copy shows the agent's value; the choices stay.
    pub(super) async fn agent_config_changed(
        &self,
        session: &SessionId,
        agent: &str,
        options: &[ConfigOption],
        sink: &dyn RunSink,
    ) {
        let options = to_contract(options);
        emit(sink, agent, options.clone()).await;
        if let Err(error) = self
            .store
            .set_acp_offered(session, &options_to_json(&options))
            .await
        {
            tracing::warn!(event = "acp.config_store_failed", agent, %error, "ACP agent config options could not be stored");
        }
    }
}

async fn emit(sink: &dyn RunSink, agent: &str, options: Vec<ExternalAgentConfigOption>) {
    sink.emit(QueryEvent::ExternalAgentConfig {
        agent: agent.to_owned(),
        options,
    })
    .await;
}

/// The handler side (Node `V4ExternalAgentConfigStore`): the session store and the agent catalog.
#[async_trait]
impl ExternalAgentConfigs for AcpHost {
    async fn config(&self, session: &SessionId) -> Result<AcpSessionConfig, StoreError> {
        self.store.acp_config(session).await
    }

    async fn catalog(&self, agent: &str) -> Option<Vec<ExternalAgentConfigOption>> {
        self.catalog.read_agent(agent).await
    }

    async fn choose(
        &self,
        session: &SessionId,
        agent: &str,
        config_id: &str,
        value: &str,
    ) -> Result<(), StoreError> {
        self.store
            .set_acp_choice(session, agent, config_id, value)
            .await
    }

    async fn set_offered(
        &self,
        session: &SessionId,
        options: &[ExternalAgentConfigOption],
    ) -> Result<(), StoreError> {
        self.store
            .set_acp_offered(session, &options_to_json(options))
            .await
    }
}
