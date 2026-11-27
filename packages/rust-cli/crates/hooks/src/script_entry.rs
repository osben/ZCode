//! Fork (specs/fork-rust-hook-script-entry.md, D24): a project hook's direct entry script. The script's content is
//! part of the declaration digest and is checked again right before each run, so a trusted hook whose script is
//! swapped, deleted or unreadable does not run. Ports Node `identifyWorkspaceHookScriptPath`
//! (`packages/shared/src/workspace-hook-config.ts`); the IO lives in the cli.

use async_trait::async_trait;
use rust_cli_kernel_api::env::WorkspaceRef;
use serde_json::{Value, json};

use crate::node_config::{NodeHook, NodeHookKind, NodeShell};

/// Node `SCRIPT_INTERPRETERS`.
const INTERPRETERS: [&str; 8] = [
    "sh", "bash", "zsh", "node", "python", "python3", "ruby", "perl",
];
/// `${VAR}/`: a process hook expands it as text into one argv entry.
const PROCESS_PREFIXES: [&str; 2] = ["${ZCODE_PROJECT_DIR}/", "${CLAUDE_PROJECT_DIR}/"];
/// `"$VAR"/`: the only form a shell expands inside quotes, so a space in the project dir does not split it.
const COMMAND_PREFIXES: [&str; 2] = ["\"$ZCODE_PROJECT_DIR\"/", "\"$CLAUDE_PROJECT_DIR\"/"];

/// What a script read found (Node `WorkspaceHookScriptState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptState {
    /// A regular file read in full; the sha256 of its content, lowercase hex.
    File(String),
    /// Not found, or a path component is not a directory.
    Missing,
    /// Not a regular file, too large, another error, or the deadline passed.
    Unverifiable,
}

impl ScriptState {
    /// Node `canonicalScriptState`.
    pub(crate) fn canonical(&self) -> Value {
        match self {
            Self::File(sha256) => json!(["file", sha256]),
            Self::Missing => json!(["missing"]),
            Self::Unverifiable => json!(["unverifiable"]),
        }
    }
}

/// A declaration's entry script and its state at discovery (Node `WorkspaceHookScriptEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptEntry {
    /// Relative to the workspace root, `/` separated, normalized.
    pub path: String,
    pub state: ScriptState,
}

impl ScriptEntry {
    /// Node `isWorkspaceHookScriptUnavailable`: no reviewable content, so it can be neither trusted nor run.
    pub fn unavailable(&self) -> bool {
        !matches!(self.state, ScriptState::File(_))
    }
}

/// Reads an entry script's state right before a run; the cli implements it over the workspace's files.
#[async_trait]
pub trait ScriptVerifier: Send + Sync {
    async fn state(&self, workspace: &WorkspaceRef, path: &str) -> ScriptState;
}

/// The recorded script of an admitted project hook (`CommandHook::script`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptCheck {
    pub path: String,
    pub sha256: String,
}

/// Node `identifyWorkspaceHookScriptPath`: the declaration's direct entry script, relative to the cwd it runs in.
/// `windows` is the platform the hook runs on.
pub fn script_path(hook: &NodeHook, windows: bool) -> Option<String> {
    match &hook.kind {
        NodeHookKind::Process { args } => {
            if INTERPRETERS.contains(&hook.command.as_str()) {
                let script = args.first()?;
                if script.starts_with('-') {
                    return None;
                }
                return normalize(script, &PROCESS_PREFIXES, true);
            }
            // Windows completes a path without an extension from PATHEXT, so another file would run.
            if windows && extname(&hook.command, true).is_empty() {
                return None;
            }
            normalize(&hook.command, &PROCESS_PREFIXES, false)
        }
        NodeHookKind::Command { shell, .. } => {
            // cmd.exe parses a command its own way; only a process hook binds its script on Windows.
            if windows || matches!(shell, NodeShell::Named(_)) {
                return None;
            }
            // Only ASCII space and tab split words, like the shell's default; any other blank stays in a token
            // and fails the character check.
            let tokens: Vec<&str> = hook
                .command
                .trim_matches([' ', '\t'])
                .split([' ', '\t'])
                .filter(|token| !token.is_empty())
                .collect();
            let tokens = if tokens.is_empty() { vec![""] } else { tokens };
            if !tokens
                .iter()
                .all(|token| safe_token(strip_prefix(token, &COMMAND_PREFIXES).0))
            {
                return None;
            }
            let first = tokens[0];
            if INTERPRETERS.contains(&first) {
                let second = tokens.get(1)?;
                if second.starts_with('-') {
                    return None;
                }
                return normalize(second, &COMMAND_PREFIXES, true);
            }
            normalize(first, &COMMAND_PREFIXES, false)
        }
    }
}

/// Node `SAFE_COMMAND_TOKEN`: `^[A-Za-z0-9_./@+=:,-]*$`.
fn safe_token(token: &str) -> bool {
    token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_./@+=:,-".contains(&b))
}

/// Node `SCRIPT_PATH_TOKEN`: `^[A-Za-z0-9_./-]+$`.
fn path_token(path: &str) -> bool {
    !path.is_empty()
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
}

fn strip_prefix<'a>(value: &'a str, prefixes: &[&str]) -> (&'a str, bool) {
    prefixes
        .iter()
        .find_map(|prefix| value.strip_prefix(prefix))
        .map_or((value, false), |rest| (rest, true))
}

/// Node `normalizeScriptPath`.
fn normalize(value: &str, prefixes: &[&str], allow_bare_name: bool) -> Option<String> {
    let (rest, matched) = strip_prefix(value, prefixes);
    if !matched && !rest.contains('/') {
        // A bare name in the direct position is a PATH lookup; after an interpreter it may be a subcommand
        // (`node inspect x.js`), so it needs an extension.
        if !allow_bare_name || extname(rest, false).is_empty() {
            return None;
        }
    }
    if !path_token(rest) || rest.starts_with('/') {
        return None;
    }
    // A parent segment and symlinks resolve in an order that can change the target: never folded.
    if rest.split('/').any(|segment| segment == "..") {
        return None;
    }
    let normalized = posix_normalize(rest);
    (normalized != ".").then_some(normalized)
}

/// Node `path.posix.normalize` for a relative path without `..` segments: drops empty and `.` segments and keeps a
/// trailing slash.
fn posix_normalize(path: &str) -> String {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    let mut out = if segments.is_empty() {
        ".".to_owned()
    } else {
        segments.join("/")
    };
    if path.ends_with('/') {
        out.push('/');
    }
    out
}

/// Node `path.extname`: from the last `.` of the last segment, empty when the segment has none, starts with its only
/// dot, or is `..`. `windows` also splits on `\`.
fn extname(path: &str, windows: bool) -> &str {
    let is_sep = |c: char| c == '/' || (windows && c == '\\');
    let trimmed = path.trim_end_matches(is_sep);
    let base = trimmed.rsplit(is_sep).next().unwrap_or(trimmed);
    if base == ".." {
        return "";
    }
    match base.rfind('.') {
        None | Some(0) => "",
        Some(at) => &base[at..],
    }
}

#[cfg(test)]
#[path = "script_entry_tests.rs"]
mod tests;
