//! Actor persona normalization (Node `engine/persona.ts` `normalizePersona`).
//!
//! The result is the JSON object Node stores as the persona, with keys in the order Node's assignments
//! create them: `name`, `system`, `model`, `budget` from the object (or `system` from a string), then
//! `name` from the createActor argument when the persona has none. Unknown keys are dropped; `budget`
//! keeps only a valid `webSearch` count.
use serde_json::{Map, Value};

/// Node `MAX_WEB_SEARCH_BUDGET_PER_ASK`.
pub const MAX_WEB_SEARCH_BUDGET_PER_ASK: f64 = 1024.0;

/// Normalize `(name, persona)` the way createActor does. `persona` is the JSON the script sent: a
/// string is a system prompt, an object is read field by field.
pub fn normalize_persona(name: Option<&str>, persona: Option<&Value>) -> Value {
    let mut base = Map::new();
    match persona {
        Some(Value::String(system)) => {
            base.insert("system".into(), Value::String(system.clone()));
        }
        Some(Value::Object(fields)) => {
            if let Some(Value::String(text)) = fields.get("name") {
                base.insert("name".into(), Value::String(text.clone()));
            }
            if let Some(Value::String(text)) = fields.get("system") {
                base.insert("system".into(), Value::String(text.clone()));
            }
            if let Some(Value::String(text)) = fields.get("model") {
                base.insert("model".into(), Value::String(text.clone()));
            }
            if let Some(budget) = normalize_budget(fields.get("budget")) {
                base.insert("budget".into(), budget);
            }
        }
        _ => {}
    }
    if !base.contains_key("name")
        && let Some(name) = name
    {
        base.insert("name".into(), Value::String(name.to_owned()));
    }
    Value::Object(base)
}

/// Node `normalizeBudget`: `{webSearch}` only when the count is an integer in range.
fn normalize_budget(budget: Option<&Value>) -> Option<Value> {
    let Value::Object(fields) = budget? else {
        return None;
    };
    let web_search = fields.get("webSearch")?.as_f64()?;
    let valid =
        web_search.fract() == 0.0 && (0.0..=MAX_WEB_SEARCH_BUDGET_PER_ASK).contains(&web_search);
    if !valid {
        return None;
    }
    let mut out = Map::new();
    out.insert("webSearch".into(), Value::from(web_search as u64));
    Some(Value::Object(out))
}

/// The persona's `name` field, as the duplicate check reads it (`spec.name`).
pub fn persona_name(persona: &Value) -> Option<&str> {
    persona.get("name")?.as_str()
}

/// The persona's `model` field (Node `persona.model`): the name written in the script.
pub fn persona_model(persona: &Value) -> Option<String> {
    persona.get("model")?.as_str().map(str::to_owned)
}

/// Node `personaIdentity`: the persona without `model` and `budget`. Changing either is the user's choice for
/// the next work (an amend may raise a budget), so it must not make finished work run again.
pub fn persona_identity(persona: &Value) -> Value {
    match persona {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "model" && key.as_str() != "budget")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(value: &Value) -> String {
        rust_cli_base::js::json::stringify(value)
    }

    #[test]
    fn a_string_persona_is_the_system_prompt_and_the_argument_names_it() {
        assert_eq!(
            text(&normalize_persona(Some("alpha"), Some(&json!("sys")))),
            r#"{"system":"sys","name":"alpha"}"#
        );
    }

    #[test]
    fn the_persona_name_wins_over_the_argument_and_keeps_its_place() {
        let persona = json!({"model": "m", "name": "own", "budget": {"webSearch": 5}});
        assert_eq!(
            text(&normalize_persona(Some("arg"), Some(&persona))),
            r#"{"name":"own","model":"m","budget":{"webSearch":5}}"#
        );
    }

    #[test]
    fn bad_budgets_and_unknown_keys_are_dropped() {
        let persona = json!({"budget": {"webSearch": 2.5}, "extra": 1, "system": 3});
        assert_eq!(text(&normalize_persona(None, Some(&persona))), "{}");
    }
}
