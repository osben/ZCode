//! Launch rules, child environment and launch key (Node `packages/shared/src/acp-launch-rules/contract.ts`,
//! `packages/acp-agent-runtime/src/launch.ts`, `acpLaunchKey` in the worker's `acp-session-pool.ts`).
//!
//! Lengths are JS string lengths (UTF-16 units), so a value accepted by the settings bridge is accepted here.

use std::collections::BTreeMap;

use rust_cli_base::js::string::{trim, utf16_len};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{AcpError, AcpErrorCode};

const COMMAND_MAX: usize = 4096;
const ARGS_MAX: usize = 32;
const ARG_MAX: usize = 4096;
const ENV_PAIRS_MAX: usize = 64;
const ENV_VALUE_MAX: usize = 8192;

/// One agent launch: the sidecar record of the agent plus the session's working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpLaunch {
    pub agent_id: String,
    pub command: String,
    pub args: Vec<String>,
    /// Explicit overrides from the sidecar record (`None` when the record has no `env`).
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: String,
}

fn invalid(message: impl Into<String>) -> AcpError {
    AcpError::new(AcpErrorCode::InvalidLaunch, message)
}

fn has_line_char(value: &str) -> bool {
    value.contains(['\0', '\r', '\n'])
}

fn is_env_name(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

const LOADER_EXACT: [&str; 18] = [
    "NODE_OPTIONS",
    "BASH_ENV",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "PERL5OPT",
    "PERL5LIB",
    "RUBYOPT",
    "RUBYLIB",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "ZDOTDIR",
    "ENV",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_ASKPASS",
    "GIT_PROXY_COMMAND",
];

/// Loader, interpreter-startup and exec-hook variables an override may never set (`LOADER_ENV_KEY_RE`, case-insensitive).
pub fn is_loader_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
        || upper.starts_with("BASH_FUNC_")
        || LOADER_EXACT.contains(&upper.as_str())
}

/// `describeAcpLaunchProblem` plus the cwd checks of `validateLaunchOptions`, with Node's messages.
pub fn validate(launch: &AcpLaunch) -> Result<(), AcpError> {
    let command = trim(&launch.command);
    if command.is_empty() {
        return Err(invalid("command must be a non-empty string"));
    }
    if utf16_len(command) > COMMAND_MAX {
        return Err(invalid(format!("command exceeds {COMMAND_MAX} characters")));
    }
    if has_line_char(&launch.command) {
        return Err(invalid("command must not contain NUL, CR or LF characters"));
    }
    if launch.args.len() > ARGS_MAX {
        return Err(invalid(format!(
            "args must contain at most {ARGS_MAX} entries"
        )));
    }
    for arg in &launch.args {
        if utf16_len(arg) > ARG_MAX {
            return Err(invalid(format!("arg exceeds {ARG_MAX} characters")));
        }
        if has_line_char(arg) {
            return Err(invalid("args must not contain NUL, CR or LF characters"));
        }
    }
    if let Some(env) = &launch.env {
        if env.len() > ENV_PAIRS_MAX {
            return Err(invalid(format!(
                "env must contain at most {ENV_PAIRS_MAX} entries"
            )));
        }
        for (key, value) in env {
            if !is_env_name(key) {
                return Err(invalid(format!(
                    "env key \"{key}\" is not a valid environment name"
                )));
            }
            if is_loader_env_key(key) {
                return Err(invalid(format!(
                    "env key \"{key}\" is a loader/injection variable and cannot be set"
                )));
            }
            if utf16_len(value) > ENV_VALUE_MAX {
                return Err(invalid(format!(
                    "env value for \"{key}\" must be a string of at most {ENV_VALUE_MAX} characters"
                )));
            }
            if value.contains('\0') {
                return Err(invalid(format!(
                    "env value for \"{key}\" must not contain NUL characters"
                )));
            }
        }
    }
    if !std::path::Path::new(&launch.cwd).is_absolute() {
        return Err(invalid("cwd must be an absolute path"));
    }
    if launch.cwd.contains('\0') {
        return Err(invalid("cwd must not contain NUL characters"));
    }
    Ok(())
}

/// Runtime variables no subprocess inherits (`SANITIZED_RUNTIME_ENV_KEYS` in `packages/shared/src/runtimeEnv.ts`).
const SANITIZED_RUNTIME_ENV_KEYS: &[&str] = &[
    "NODE_ENV",
    "ELECTRON_RUN_AS_NODE",
    "NODE_NO_WARNINGS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY",
    "ZCODE_REMOTE_HTTP_PROXY",
    "ZCODE_REMOTE_NO_PROXY",
    "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
    "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
    "ZCODE_CUA_PLUGIN_AUTHORITY",
    "ZCODE_OFFICIAL_ENDPOINT",
    "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_COMPRESSION",
    "ZCODE_MODEL_TELEMETRY_ENABLED",
    "ZCODE_TELEMETRY_DEVICE_MID",
    "ZCODE_TELEMETRY_USER_ID",
    "ZCODE_TELEMETRY_USER_ID_HASH",
    "ZCODE_TELEMETRY_USER_SUBJECT_ID",
    "ZCODE_TELEMETRY_IDENTITY_STATE",
    "ZCODE_TELEMETRY_RUNTIME_SURFACE",
    "ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION",
];

const PACKAGE_MANAGERS: [&str; 3] = ["NPM_CONFIG", "YARN", "PNPM"];
const PACKAGE_MANAGER_KEYS: [&str; 7] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "CAFILE",
    "CA",
];

/// `shouldSanitizeZCodeRuntimeEnvKey`: the listed runtime keys (case-insensitive) and package-manager proxy/CA keys.
pub fn is_sanitized_runtime_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if SANITIZED_RUNTIME_ENV_KEYS.contains(&upper.as_str()) {
        return true;
    }
    PACKAGE_MANAGERS.iter().any(|manager| {
        upper
            .strip_prefix(manager)
            .and_then(|rest| rest.strip_prefix('_'))
            .is_some_and(|rest| PACKAGE_MANAGER_KEYS.contains(&rest))
    })
}

const SECRET_SEGMENTS: [&str; 9] = [
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWORDS",
    "PASSWD",
    "CREDENTIAL",
    "CREDENTIALS",
    "APIKEY",
];

/// `SECRET_NAME_RE`: a secret word standing between `_` separators (or the ends of the name), case-insensitive.
pub fn is_secret_env_key(key: &str) -> bool {
    key.to_ascii_uppercase()
        .split('_')
        .any(|segment| SECRET_SEGMENTS.contains(&segment))
}

/// `buildChildEnv`: the parent environment minus runtime and secret-named keys, then the explicit overrides.
pub fn child_env(
    parent: &[(String, String)],
    overrides: Option<&BTreeMap<String, String>>,
) -> Result<BTreeMap<String, String>, AcpError> {
    let mut env: BTreeMap<String, String> = parent
        .iter()
        .filter(|(key, _)| !is_sanitized_runtime_env_key(key) && !is_secret_env_key(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for (key, value) in overrides.into_iter().flatten() {
        if is_loader_env_key(key) {
            return Err(invalid(format!(
                "env key \"{key}\" is a loader/injection variable"
            )));
        }
        env.insert(key.clone(), value.clone());
    }
    Ok(env)
}

/// `acpLaunchFingerprint`: `JSON.stringify({agentId, command, args, env, cwd})` with env as sorted `[key, value]` pairs.
pub fn fingerprint(launch: &AcpLaunch) -> String {
    let env: Vec<Value> = launch
        .env
        .iter()
        .flatten()
        .map(|(key, value)| json!([key, value]))
        .collect();
    let value = json!({
        "agentId": launch.agent_id,
        "command": launch.command,
        "args": launch.args,
        "env": env,
        "cwd": launch.cwd,
    });
    rust_cli_base::js::json::stringify(&value)
}

/// `acpLaunchKey`: hex sha256 of the fingerprint. The env can carry credentials, so only the digest is stored.
pub fn launch_key(launch: &AcpLaunch) -> String {
    let digest = Sha256::digest(fingerprint(launch).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
