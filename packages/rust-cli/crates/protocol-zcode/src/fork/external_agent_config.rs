//! Fork: `setExternalAgentConfigOption`, one select of the session's ACP agent (specs/fork-rust-agent-parity.md "ACP
//! external agents", rule 13; Node `commands/handlers/external-agent-config.ts`).
//!
//! The session owns the chosen values. The command stores the choice, updates the display copy and has the session
//! actor append the `ExternalAgentConfig` event; it never touches the agent process. The turn applies the choice
//! before its prompt, so a running turn is not interrupted.

use std::collections::BTreeMap;

use rust_cli_kernel_api::external_agent_config::{ExternalAgentConfigOption, options_from_json};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command};
use rust_cli_kernel_api::store::StoreError;
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use super::session_config::held_config;
use crate::commands::{payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

const INVALID: &str = "config.invalid";
const NOT_EXTERNAL_AGENT: &str = "config.notExternalAgent";
const NOT_AVAILABLE: &str = "config.notAvailable";
const NOT_AVAILABLE_MESSAGE: &str = "Agent options are available after the first message.";

/// Node `setExternalAgentConfigOption` payload (`.strict()`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetOptionPayload {
    session_id: String,
    config_id: String,
    value: String,
}

fn failed(envelope: &Envelope, revision: u64, code: &str, message: impl Into<String>) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        code,
        message,
        revision,
    )
}

pub(crate) async fn set_option(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: SetOptionPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    if [&body.session_id, &body.config_id, &body.value]
        .iter()
        .any(|field| field.is_empty())
    {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "Invalid setExternalAgentConfigOption payload: empty field",
            revision,
        );
    }
    if envelope.session_id.as_deref() != Some(body.session_id.as_str()) {
        return failed(
            envelope,
            revision,
            INVALID,
            "The option belongs to a different session than the command.",
        );
    }
    let Some(configs) = server.context.external_agent_configs() else {
        return failed(
            envelope,
            revision,
            "fault.command.capabilityUnsupported",
            format!(
                "capability not supported by this session runtime: externalAgentConfig (session {})",
                body.session_id
            ),
        );
    };
    // Two choices are decided and applied in arrival order, as two model switches are.
    let _turn = match live.sink.config_switch().await {
        Ok(turn) => turn,
        Err(reason) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "fault.command.inputRejected",
                reason,
                revision,
            );
        }
    };
    let (selection, _, _) = held_config(live).await;
    let Some(agent) = selection.external_agent().map(str::to_owned) else {
        return failed(
            envelope,
            revision,
            NOT_EXTERNAL_AGENT,
            "Agent options apply only when the session model is an ACP agent.",
        );
    };
    let session = SessionId::new(body.session_id.as_str());
    let config = match configs.config(&session).await {
        Ok(config) => config,
        Err(error) => return store_failed(envelope, revision, &error),
    };
    // Stored options of another agent describe a process configuration that no longer applies.
    if config
        .agent_id
        .as_deref()
        .is_some_and(|stored| stored != agent)
    {
        return failed(envelope, revision, NOT_AVAILABLE, NOT_AVAILABLE_MESSAGE);
    }
    // The live snapshot of the session wins. Before the first turn the agent's catalog offers the options, and the
    // choice is kept as a pending choice that the first turn applies.
    let shown = config.offered.as_ref().and_then(options_from_json);
    let bound = shown.is_some();
    let offered = match shown {
        Some(offered) => offered,
        None => match configs.catalog(&agent).await {
            Some(offered) => offered,
            None => return failed(envelope, revision, NOT_AVAILABLE, NOT_AVAILABLE_MESSAGE),
        },
    };
    let Some(option) = offered
        .iter()
        .find(|option| option.id == body.config_id && option.offers(&body.value))
    else {
        return failed(
            envelope,
            revision,
            INVALID,
            "The agent does not offer this option value.",
        );
    };
    // An explicit choice of the shown value still pins it unless it is already the chosen value: the display copy may
    // show an agent-initiated value that the next reconcile would otherwise revert.
    if config.choices.get(&body.config_id) == Some(&body.value)
        && option.current_value == body.value
    {
        return Ack::refused(
            &envelope.command_id,
            Status::Noop,
            "config.unchanged",
            "the value is already in effect",
            revision,
        );
    }
    if let Err(error) = configs
        .choose(&session, &agent, &body.config_id, &body.value)
        .await
    {
        return store_failed(envelope, revision, &error);
    }
    // Every choice in effect is shown: a pending session overlays the catalog with all of its stored choices plus this
    // one (the set the first turn applies); a bound session shows only this choice.
    let mut chosen = if bound {
        BTreeMap::new()
    } else {
        config.choices.clone()
    };
    chosen.insert(body.config_id.clone(), body.value.clone());
    let options = overlay(offered, &chosen);
    // Only a binding has a stored copy; a pending session has none until its first turn writes one.
    if let Err(error) = configs.set_offered(&session, &options).await {
        return store_failed(envelope, revision, &error);
    }
    match send(
        live.handle.as_ref(),
        &envelope.command_id,
        Command::PublishExternalAgentConfig { agent, options },
    )
    .await
    {
        KernelAck::Rejected { reason } => {
            failed(envelope, revision, "fault.command.executionFailed", reason)
        }
        _ => Ack::accepted(&envelope.command_id, revision, None),
    }
}

/// Node `seedExternalAgentConfig`, on a cold open: the stored display copy, when the session's model is still that
/// agent. An event of the session's own turn wins over it.
pub(crate) async fn seed(server: &Server, live: &Bridged<Live>, session: &SessionId) {
    let Some(configs) = server.context.external_agent_configs() else {
        return;
    };
    let (selection, _, _) = held_config(live).await;
    let Some(agent) = selection.external_agent() else {
        return;
    };
    let config = match configs.config(session).await {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(event = "acp.config_seed_failed", %error, "ACP agent options could not be read");
            return;
        }
    };
    if config.agent_id.as_deref() != Some(agent) {
        return;
    }
    if let Some(options) = config.offered.as_ref().and_then(options_from_json) {
        live.sink.seed_external_agent_config(agent, &options);
    }
}

/// The offered options with the chosen values as their current values (a value the option does not offer is ignored).
fn overlay(
    offered: Vec<ExternalAgentConfigOption>,
    chosen: &BTreeMap<String, String>,
) -> Vec<ExternalAgentConfigOption> {
    offered
        .into_iter()
        .map(|mut option| {
            if let Some(value) = chosen.get(&option.id)
                && option.offers(value)
            {
                option.current_value.clone_from(value);
            }
            option
        })
        .collect()
}

/// A store without Node's ACP tables (rule 15) has nowhere to keep a choice; any other failure is Node's generic
/// execution failure.
fn store_failed(envelope: &Envelope, revision: u64, error: &StoreError) -> Ack {
    match error {
        StoreError::Unsupported { .. } => {
            failed(envelope, revision, NOT_AVAILABLE, NOT_AVAILABLE_MESSAGE)
        }
        other => failed(
            envelope,
            revision,
            "fault.command.executionFailed",
            other.to_string(),
        ),
    }
}

#[cfg(test)]
#[path = "external_agent_config_tests.rs"]
mod tests;
