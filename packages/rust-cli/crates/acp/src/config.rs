//! Session configuration options (Node `runtime-config.ts`, contract `external-agent-config.ts`; spec
//! specs/acp-agent-runtime.md "S6").
//!
//! The agent offers select options (`configOptions`) or, in older agents, only `modes`; legacy modes become one
//! synthesized "mode" option that is changed through `session/set_mode`.

use serde_json::{Map, Value, json};

use crate::error::{AcpError, AcpErrorCode};

pub(crate) const SYNTHESIZED_MODE_ID: &str = "mode";

/// One value of a select option. `group` is the name of the group a grouped value came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigValue {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    pub group: Option<String>,
}

/// One select option in the turn contract's shape (`ExternalAgentConfigOption`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub current_value: String,
    pub options: Vec<ConfigValue>,
}

fn optional(value: &Option<String>) -> Value {
    value.as_ref().map_or(Value::Null, |text| json!(text))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

impl ConfigOption {
    /// `externalAgentConfigOffers`.
    pub fn offers(&self, value: &str) -> bool {
        self.options
            .iter()
            .any(|candidate| candidate.value == value)
    }

    /// The contract JSON with the fixed field order of `canonicalExternalAgentConfig`.
    pub fn to_json(&self) -> Value {
        let options: Vec<Value> = self
            .options
            .iter()
            .map(|value| {
                json!({
                    "value": value.value,
                    "name": value.name,
                    "description": optional(&value.description),
                    "group": optional(&value.group),
                })
            })
            .collect();
        json!({
            "id": self.id,
            "name": self.name,
            "description": optional(&self.description),
            "category": optional(&self.category),
            "currentValue": self.current_value,
            "options": options,
        })
    }

    /// Reads one option in the contract shape (a stored display copy or catalog entry); `None` when it is not one.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let nullable = |key: &str| -> Option<Option<String>> {
            match object.get(key) {
                None | Some(Value::Null) => Some(None),
                Some(Value::String(text)) => Some(Some(text.clone())),
                Some(_) => None,
            }
        };
        let mut options = Vec::new();
        for entry in object.get("options")?.as_array()? {
            let entry = entry.as_object()?;
            let entry_nullable = |key: &str| -> Option<Option<String>> {
                match entry.get(key) {
                    None | Some(Value::Null) => Some(None),
                    Some(Value::String(text)) => Some(Some(text.clone())),
                    Some(_) => None,
                }
            };
            options.push(ConfigValue {
                value: entry.get("value")?.as_str()?.to_owned(),
                name: entry.get("name")?.as_str()?.to_owned(),
                description: entry_nullable("description")?,
                group: entry_nullable("group")?,
            });
        }
        Some(Self {
            id: object.get("id")?.as_str()?.to_owned(),
            name: object.get("name")?.as_str()?.to_owned(),
            description: nullable("description")?,
            category: nullable("category")?,
            current_value: object.get("currentValue")?.as_str()?.to_owned(),
            options,
        })
    }
}

/// A list of options as contract JSON.
pub fn options_to_json(options: &[ConfigOption]) -> Value {
    Value::Array(options.iter().map(ConfigOption::to_json).collect())
}

/// A stored list in the contract shape; `None` when any entry is malformed.
pub fn options_from_json(value: &Value) -> Option<Vec<ConfigOption>> {
    value
        .as_array()?
        .iter()
        .map(ConfigOption::from_json)
        .collect()
}

fn normalize_value(raw: &Value, group: Option<&str>) -> Option<ConfigValue> {
    let raw = raw.as_object()?;
    Some(ConfigValue {
        value: raw.get("value")?.as_str()?.to_owned(),
        name: raw.get("name")?.as_str()?.to_owned(),
        description: optional_string(raw.get("description")),
        group: group.map(str::to_owned),
    })
}

fn normalize_select(raw: &Value) -> Option<ConfigOption> {
    let raw = raw.as_object()?;
    if raw.get("type").and_then(Value::as_str) != Some("select") {
        return None;
    }
    let mut options = Vec::new();
    for entry in raw.get("options")?.as_array()? {
        if let Some(grouped) = entry.get("options").and_then(Value::as_array) {
            let group = entry.get("name").and_then(Value::as_str);
            options.extend(
                grouped
                    .iter()
                    .filter_map(|item| normalize_value(item, group)),
            );
            continue;
        }
        options.extend(normalize_value(entry, None));
    }
    Some(ConfigOption {
        id: raw.get("id")?.as_str()?.to_owned(),
        name: raw.get("name")?.as_str()?.to_owned(),
        description: optional_string(raw.get("description")),
        category: optional_string(raw.get("category")),
        current_value: raw.get("currentValue")?.as_str()?.to_owned(),
        options,
    })
}

/// `normalizeConfigOptions`: the select options of an ACP `configOptions` array; anything else is skipped.
pub fn normalize_options(raw: Option<&Value>) -> Vec<ConfigOption> {
    raw.and_then(Value::as_array)
        .map(|items| items.iter().filter_map(normalize_select).collect())
        .unwrap_or_default()
}

fn synthesize_mode(modes: &Map<String, Value>) -> ConfigOption {
    let options = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .map(|modes| {
            modes
                .iter()
                .map(|mode| ConfigValue {
                    value: mode
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    name: mode
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    description: optional_string(mode.get("description")),
                    group: None,
                })
                .collect()
        })
        .unwrap_or_default();
    ConfigOption {
        id: SYNTHESIZED_MODE_ID.to_owned(),
        name: "Mode".to_owned(),
        description: None,
        category: Some("mode".to_owned()),
        current_value: modes
            .get("currentModeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        options,
    }
}

/// How a config change reaches the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ConfigRequest {
    /// `session/set_mode {sessionId, modeId}` (a synthesized legacy mode).
    SetMode,
    /// `session/set_config_option {sessionId, configId, value}`.
    SetConfigOption,
}

impl ConfigRequest {
    pub(crate) fn method(&self) -> &'static str {
        match self {
            ConfigRequest::SetMode => "session/set_mode",
            ConfigRequest::SetConfigOption => "session/set_config_option",
        }
    }
}

/// The current snapshot and the one the handshake returned (`AcpConfigState`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ConfigState {
    options: Vec<ConfigOption>,
    handshake: Vec<ConfigOption>,
    synthesized_mode: bool,
}

impl ConfigState {
    pub(crate) fn options(&self) -> &[ConfigOption] {
        &self.options
    }

    pub(crate) fn handshake_options(&self) -> &[ConfigOption] {
        &self.handshake
    }

    /// The `configOptions` / `modes` of a `session/new` or `session/load` response.
    pub(crate) fn reset(&mut self, response: &Value) {
        let normalized = normalize_options(response.get("configOptions"));
        match response.get("modes").and_then(Value::as_object) {
            Some(modes) if normalized.is_empty() => {
                self.options = vec![synthesize_mode(modes)];
                self.synthesized_mode = true;
            }
            _ => {
                self.options = normalized;
                self.synthesized_mode = false;
            }
        }
        self.handshake = self.options.clone();
    }

    /// Validates a change and says which request carries it.
    pub(crate) fn plan_set(&self, config_id: &str, value: &str) -> Result<ConfigRequest, AcpError> {
        let Some(option) = self
            .options
            .iter()
            .find(|candidate| candidate.id == config_id)
        else {
            return Err(AcpError::new(
                AcpErrorCode::InvalidConfig,
                format!("Unknown config option \"{config_id}\""),
            ));
        };
        if !option.offers(value) {
            return Err(AcpError::new(
                AcpErrorCode::InvalidConfig,
                format!("Config option \"{config_id}\" does not offer \"{value}\""),
            ));
        }
        Ok(
            if self.synthesized_mode && config_id == SYNTHESIZED_MODE_ID {
                ConfigRequest::SetMode
            } else {
                ConfigRequest::SetConfigOption
            },
        )
    }

    /// Applies the agent's answer: a returned `configOptions` array replaces the snapshot, otherwise the value is set.
    pub(crate) fn applied(&mut self, config_id: &str, value: &str, response: &Value) {
        match response.get("configOptions") {
            Some(options @ Value::Array(_)) => self.replace(options),
            _ => {
                self.set_current(|option| option.id == config_id, value);
            }
        }
    }

    /// `config_option_update` / `current_mode_update`: `Some(true)` when the snapshot changed and is surfaced,
    /// `Some(false)` when the update was ignored, `None` when the update is not a config update.
    pub(crate) fn surface(&mut self, update: &Value) -> Option<bool> {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("config_option_update") => {
                self.replace(update.get("configOptions").unwrap_or(&Value::Null));
                Some(true)
            }
            Some("current_mode_update") => {
                let mode = update
                    .get("currentModeId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Some(self.set_current(
                    |option| {
                        option.category.as_deref() == Some("mode")
                            || option.id == SYNTHESIZED_MODE_ID
                    },
                    mode,
                ))
            }
            _ => None,
        }
    }

    fn replace(&mut self, options: &Value) {
        self.options = normalize_options(Some(options));
        self.synthesized_mode = false;
    }

    fn set_current(&mut self, matches: impl Fn(&ConfigOption) -> bool, value: &str) -> bool {
        match self.options.iter_mut().find(|option| matches(option)) {
            Some(option) => {
                option.current_value = value.to_owned();
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
