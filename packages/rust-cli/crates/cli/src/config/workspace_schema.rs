//! Node's strict `workspaceHooksConfigSchema` (`packages/shared/src/workspace-hook-config.ts`) for a project file's
//! `hooks` value. Node parses project sources with it and treats a failure as an unreadable file
//! (`readWorkspaceHookProjectSources`), while `NodeHooks::from_json` skips bad entries; the review checks this first so
//! it never lists or writes a declaration from a config Node rejects.

use serde_json::{Map, Value};

/// Node `WORKSPACE_HOOK_EVENT_NAMES`: the keys of the strict `events` object.
const EVENTS: [&str; 10] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
];

/// `Ok` when Node's schema accepts the value; the error names the first rejected field.
pub(crate) fn check(value: &Value) -> Result<(), String> {
    let root = object(value, "hooks")?;
    only(
        root,
        &["enabled", "timeoutMs", "maxOutputBytes", "events"],
        "hooks",
    )?;
    boolean(root, "enabled", "hooks")?;
    positive(root, "timeoutMs", "hooks")?;
    positive(root, "maxOutputBytes", "hooks")?;
    let Some(events) = root.get("events") else {
        return Ok(());
    };
    let events = object(events, "hooks.events")?;
    only(events, &EVENTS, "hooks.events")?;
    for (event, matchers) in events {
        let at = format!("hooks.events.{event}");
        let matchers = matchers
            .as_array()
            .ok_or_else(|| format!("{at}: not an array"))?;
        for (index, matcher) in matchers.iter().enumerate() {
            check_matcher(matcher, &format!("{at}[{index}]"))?;
        }
    }
    Ok(())
}

/// `workspaceHookMatcherConfigSchema`: strict, `hooks` has at least one entry.
fn check_matcher(value: &Value, at: &str) -> Result<(), String> {
    let matcher = object(value, at)?;
    only(matcher, &["matcher", "hooks"], at)?;
    non_empty(matcher, "matcher", at)?;
    let hooks = matcher
        .get("hooks")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{at}.hooks: not an array"))?;
    if hooks.is_empty() {
        return Err(format!("{at}.hooks: empty"));
    }
    for (index, hook) in hooks.iter().enumerate() {
        check_hook(hook, &format!("{at}.hooks[{index}]"))?;
    }
    Ok(())
}

/// The `type` union of `workspaceHookProcessConfigSchema` and `workspaceHookCommandConfigSchema` (both passthrough).
fn check_hook(value: &Value, at: &str) -> Result<(), String> {
    let hook = object(value, at)?;
    match hook.get("type").and_then(Value::as_str) {
        Some("process") => {
            if let Some(args) = hook.get("args") {
                let strings = args
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string));
                if !strings {
                    return Err(format!("{at}.args: not an array of strings"));
                }
            }
        }
        Some("command") => {
            boolean(hook, "async", at)?;
            match hook.get("shell") {
                None | Some(Value::Bool(true)) => {}
                Some(Value::String(name)) if !name.is_empty() => {}
                Some(_) => return Err(format!("{at}.shell: not true or a shell name")),
            }
            positive(hook, "timeout", at)?;
        }
        _ => return Err(format!("{at}.type: not \"process\" or \"command\"")),
    }
    if non_empty(hook, "command", at)?.is_none() {
        return Err(format!("{at}.command: missing"));
    }
    boolean(hook, "enabled", at)?;
    positive(hook, "timeoutMs", at)?;
    non_empty(hook, "statusMessage", at)?;
    match hook.get("onError") {
        None => Ok(()),
        Some(Value::String(value)) if value == "allow" || value == "deny" => Ok(()),
        Some(_) => Err(format!("{at}.onError: not \"allow\" or \"deny\"")),
    }
}

fn object<'a>(value: &'a Value, at: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{at}: not an object"))
}

/// zod `.strict()`: no keys besides the declared ones.
fn only(object: &Map<String, Value>, keys: &[&str], at: &str) -> Result<(), String> {
    match object.keys().find(|key| !keys.contains(&key.as_str())) {
        Some(key) => Err(format!("{at}.{key}: unknown key")),
        None => Ok(()),
    }
}

// zod `.optional()` accepts a missing key only: `null` fails like any other wrong type.
fn boolean(object: &Map<String, Value>, key: &str, at: &str) -> Result<(), String> {
    match object.get(key) {
        None | Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(format!("{at}.{key}: not a boolean")),
    }
}

fn positive(object: &Map<String, Value>, key: &str, at: &str) -> Result<(), String> {
    match object.get(key) {
        None => Ok(()),
        Some(value) if value.as_f64().is_some_and(|n| n.is_finite() && n > 0.0) => Ok(()),
        Some(_) => Err(format!("{at}.{key}: not a positive number")),
    }
}

fn non_empty<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    at: &str,
) -> Result<Option<&'a str>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(text)),
        Some(_) => Err(format!("{at}.{key}: not a non-empty string")),
    }
}

#[cfg(test)]
#[path = "workspace_schema_tests.rs"]
mod tests;
