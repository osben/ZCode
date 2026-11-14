//! Fork: the limits of one turn that the Host's input sets (Node `prompt-turn.ts` `buildTurnToolDisallowlist`,
//! core `turn-tool-visibility.ts`; specs/fork-rust-automations.md, slice 1).
//!
//! A scheduled automation's run sends its prompt with the automation id and a tool disallowlist. Both belong to the
//! turn that input opens; the session keeps neither, so the next ordinary turn sees the usual tools.

use serde::{Deserialize, Serialize};

use crate::tool_names::{CRON_CREATE, CRON_DELETE, CRON_PAUSE_SELF, CRON_UPDATE};

/// Tools a turn dispatched by an automation never shows (Node `AUTOMATION_MUTATION_TOOL_NAMES`): the run must not
/// manage its own definition. CronList stays (read-only).
pub const AUTOMATION_MUTATION_TOOLS: [&str; 3] = [CRON_CREATE, CRON_UPDATE, CRON_DELETE];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnLimits {
    /// The automation that dispatched the turn (the Host's explicit `automationId`, trimmed and non-empty, also when
    /// decoded). It is the only target CronPauseSelf can pause; it is never derived from a command or input id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "trimmed_id"
    )]
    automation: Option<String>,
    /// Tool names the input hides from its turn (`toolDisallowlist`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_tools: Vec<String>,
}

impl TurnLimits {
    /// The limits of an input: a blank automation id is none (Node `resolveTurnAutomationId`).
    pub fn new(automation: Option<&str>, hidden_tools: Vec<String>) -> Self {
        let automation = automation
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        Self {
            automation,
            hidden_tools,
        }
    }

    /// The automation that dispatched the turn, if any.
    pub fn automation(&self) -> Option<&str> {
        self.automation.as_deref()
    }

    pub fn is_empty(&self) -> bool {
        self.automation.is_none() && self.hidden_tools.is_empty()
    }

    /// Whether CronCreate, CronUpdate and CronDelete must refuse on this turn (Node
    /// `isAutomationMutationRestrictedTurn`): it carries an automation id, or its disallowlist hides all three.
    pub fn restricts_automation_mutations(&self) -> bool {
        self.automation.is_some()
            || AUTOMATION_MUTATION_TOOLS
                .iter()
                .all(|tool| self.hidden_tools.iter().any(|hidden| hidden == tool))
    }

    /// Whether the turn hides the tool `name` from the model and refuses a call to it: the input's disallowlist, the
    /// automation mutation tools on an automation turn, and CronPauseSelf on every other turn (Node
    /// `buildTurnDisallowedTools`; ordinary turns have nothing to pause).
    pub fn hides(&self, name: &str) -> bool {
        if self.hidden_tools.iter().any(|hidden| hidden == name) {
            return true;
        }
        match self.automation {
            Some(_) => AUTOMATION_MUTATION_TOOLS.contains(&name),
            None => name == CRON_PAUSE_SELF,
        }
    }

    /// Fork: the call-time gate when the session's view is gone (its actor stopped): the turn may be an automation run,
    /// so the automation tools are refused (fail closed); CronPauseSelf has no automation id to pause either. The
    /// Host's disallowlist cannot be known without the view.
    pub fn hides_without_view(name: &str) -> bool {
        name == CRON_PAUSE_SELF || AUTOMATION_MUTATION_TOOLS.contains(&name)
    }
}

/// The `new` rule for a decoded id: trimmed, a blank one is none.
fn trimmed_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned))
}

#[cfg(test)]
#[path = "turn_limits_tests.rs"]
mod tests;
