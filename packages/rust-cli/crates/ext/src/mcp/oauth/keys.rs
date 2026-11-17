//! Credential key names and the lease path (Node `oauth-credentials.ts`, `oauth-lease.ts`).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Node `createCredentialKeyPrefix`: `mcp:oauth:` + the first 24 hex chars of
/// `sha256(name, url, clientId, scope, redirectPath)` joined by newlines, with missing fields as "".
/// A changed scope, client or redirect path therefore starts a new credential set.
pub fn credential_key_prefix(
    name: &str,
    url: &str,
    client_id: Option<&str>,
    scope: Option<&str>,
    redirect_path: Option<&str>,
) -> String {
    let joined = [
        name,
        url,
        client_id.unwrap_or(""),
        scope.unwrap_or(""),
        redirect_path.unwrap_or(""),
    ]
    .join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("mcp:oauth:{}", &hex[..24])
}

/// Node `mcpOAuthCredentialKey`: `<prefix>:<name>`.
pub fn credential_key(prefix: &str, name: &str) -> String {
    format!("{prefix}:{name}")
}

/// Node `sanitizeKeyPrefix`: every character outside `[A-Za-z0-9-]` becomes `-`, so the prefix
/// can be used in a file name on Windows as well.
pub fn sanitize_key_prefix(prefix: &str) -> String {
    prefix
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Node `resolveRefreshLockPath`: `<credentials dir>/<sanitized prefix>.refresh`. It is kept apart from the
/// `.authz` lease: the refresh lock is held while the credential file is written.
pub fn refresh_lock_path(credentials_file: &Path, key_prefix: &str) -> PathBuf {
    let dir = credentials_file.parent().unwrap_or_else(|| Path::new(""));
    dir.join(format!("{}.refresh", sanitize_key_prefix(key_prefix)))
}

/// Node `resolveAuthorizationLeasePath`: `<credentials dir>/<sanitized prefix>.authz`.
pub fn lease_path(credentials_file: &Path, key_prefix: &str) -> PathBuf {
    let dir = credentials_file.parent().unwrap_or_else(|| Path::new(""));
    dir.join(format!("{}.authz", sanitize_key_prefix(key_prefix)))
}
