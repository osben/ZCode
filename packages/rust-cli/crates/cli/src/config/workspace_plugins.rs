//! Fork (specs/fork-rust-plugin-workspace-trust.md, part 2): project `plugins.dirs` roots load only with a workspace
//! plugin trust record for their current declaration digest.
//!
//! The record file is written by the Node helper (`plugins/workspaceTrust`); this module only reads it. The digest is
//! Node's `computeWorkspacePluginDeclarationDigest`
//! (`apps/zcode-cli/packages/adapters/src/plugins/workspace-plugin-declaration/index.ts`) byte for byte, checked by
//! the Node golden in `fixtures/workspace_plugin_digest_golden.json`.

use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use rust_cli_base::names::DOT_DIR;
use rust_cli_base::path::normalize;
use rust_cli_paths::StoragePaths;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::files::ProjectFile;

const STORE_NAME: &str = "workspace-plugin-trust-v1.json";
const DIGEST_VERSION: u8 = 1;
/// Node `MANIFEST_PATHS`: the first one that exists is the manifest.
const MANIFEST_PATHS: [&str; 3] = [
    ".zcode-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
];
const HOOKS_PATH: &str = "hooks/hooks.json";
const MCP_PATH: &str = ".mcp.json";

/// One trust record of the current workspace identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Grant {
    pub(crate) plugin_root: String,
    pub(crate) declaration_digest: String,
}

/// The project candidates of the loaded project files (Node `pluginDirCandidates` per file, then deduped in
/// discovery order): a relative dir resolves against the file's base dir (`getProjectConfigBaseDir`).
pub(crate) fn project_roots(projects: &[ProjectFile]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for project in projects {
        let Some(dirs) = project
            .file
            .object()
            .and_then(|object| object.get("plugins"))
            .and_then(|plugins| plugins.get("dirs"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let base = base_dir(Path::new(&project.path));
        for dir in dirs.iter().filter_map(Value::as_str) {
            let dir = Path::new(dir);
            let root = if dir.is_absolute() {
                normalize(dir)
            } else {
                normalize(&base.join(dir))
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

/// Node `getProjectConfigBaseDir`: the parent of a `.zcode` directory, else the file's directory.
fn base_dir(config: &Path) -> PathBuf {
    let dir = config.parent().unwrap_or(config);
    if dir.file_name().is_some_and(|name| name == DOT_DIR) {
        dir.parent().unwrap_or(dir).to_path_buf()
    } else {
        dir.to_path_buf()
    }
}

/// The records of `identity` in the store beside the hook trust store. A missing, unreadable or invalid store
/// trusts nothing (Node `resolveWorkspacePluginDiscovery`).
pub(crate) async fn grants(
    paths: &StoragePaths,
    user: Option<&Map<String, Value>>,
    identity: &str,
) -> Vec<Grant> {
    let hook_store = paths.hook_trust_store(super::trust::storage_dir(user));
    let hook = hook_store.as_path();
    let file = hook.parent().unwrap_or(hook).join(STORE_NAME);
    let bytes = match rust_cli_fs::read_optional(&file).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "workspace plugin trust store unreadable; project plugins stay pending");
            return Vec::new();
        }
    };
    let Some(records) = parse_store(&bytes) else {
        tracing::warn!("workspace plugin trust store invalid; project plugins stay pending");
        return Vec::new();
    };
    records
        .into_iter()
        .filter(|(record_identity, _)| record_identity == identity)
        .map(|(_, grant)| grant)
        .collect()
}

/// Node's strict `storeSchema`: `{schemaVersion: 1, records: [{workspaceIdentity, pluginRoot, declarationDigest,
/// grantedAt}]}` with no other keys.
fn parse_store(bytes: &[u8]) -> Option<Vec<(String, Grant)>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if object.len() != 2 || object.get("schemaVersion")?.as_u64()? != 1 {
        return None;
    }
    let mut records = Vec::new();
    for record in object.get("records")?.as_array()? {
        let record = record.as_object()?;
        if record.len() != 4 {
            return None;
        }
        let text = |key: &str| {
            record
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        };
        let digest = text("declarationDigest")?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return None;
        }
        text("grantedAt")?;
        records.push((
            text("workspaceIdentity")?.to_owned(),
            Grant {
                plugin_root: text("pluginRoot")?.to_owned(),
                declaration_digest: digest.to_owned(),
            },
        ));
    }
    Some(records)
}

/// The project roots that load: not already a user dir, and trusted for their current digest. Kept in candidate
/// order (they go right after the user dirs, Node `resolveCandidates`).
pub(crate) async fn trusted_roots(
    workspace_root: &Path,
    projects: &[ProjectFile],
    user_roots: &[PathBuf],
    grants: &[Grant],
) -> Vec<PathBuf> {
    let mut trusted = Vec::new();
    for root in project_roots(projects) {
        if user_roots.contains(&root) {
            continue;
        }
        let Some(inspected) = inspect(workspace_root, &root).await else {
            continue;
        };
        if grants.iter().any(|grant| {
            grant.plugin_root == inspected.plugin_root
                && grant.declaration_digest == inspected.declaration_digest
        }) {
            trusted.push(root);
        } else {
            tracing::info!(
                plugin_root = inspected.plugin_root,
                "project plugin waits for workspace trust"
            );
        }
    }
    trusted
}

/// Node `inspectWorkspacePluginRoot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inspected {
    pub(crate) plugin_root: String,
    pub(crate) declaration_digest: String,
}

pub(crate) async fn inspect(workspace_root: &Path, root: &Path) -> Option<Inspected> {
    let root = normalize(root);
    for manifest_path in MANIFEST_PATHS {
        let manifest_file = root.join(manifest_path);
        let text = match read_text(&manifest_file).await {
            Ok(Some(text)) => text,
            Ok(None) => continue,
            Err(_) => return None,
        };
        // Like discovery: an invalid first manifest makes the plugin unavailable, no fallback to the next one.
        let manifest = valid_manifest(&text)?;
        let plugin_root = relative(&normalize(workspace_root), &root);
        let declaration_digest = digest(&root, &plugin_root, &manifest_file, &manifest).await?;
        return Some(Inspected {
            plugin_root,
            declaration_digest,
        });
    }
    None
}

/// Node `parsePluginManifest`: a JSON object whose trimmed `name` matches `^[a-z0-9][a-z0-9._-]{0,127}$`.
fn valid_manifest(text: &str) -> Option<Map<String, Value>> {
    let Value::Object(manifest) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    let name = manifest.get("name")?.as_str()?.trim();
    let mut bytes = name.bytes();
    let first = bytes.next()?;
    let ok = name.len() <= 128
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    ok.then_some(manifest)
}

#[derive(Serialize)]
struct DigestInput<'a> {
    version: u8,
    #[serde(rename = "pluginRoot")]
    plugin_root: &'a str,
    files: Vec<DigestFile>,
}

#[derive(Serialize)]
struct DigestFile {
    path: String,
    text: Option<String>,
}

/// Node `computeWorkspacePluginDeclarationDigest`. `None` when a declaration file cannot be read (Node throws).
async fn digest(
    root: &Path,
    plugin_root: &str,
    manifest_file: &Path,
    manifest: &Map<String, Value>,
) -> Option<String> {
    let mut paths = BTreeSet::new();
    paths.insert(manifest_file.to_path_buf());
    paths.insert(root.join(HOOKS_PATH));
    paths.insert(root.join(MCP_PATH));
    for key in ["hooks", "mcpServers"] {
        if let Some(spec) = manifest.get(key) {
            referenced(root, spec, &mut paths);
        }
    }
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let text = read_text(path).await.ok()?;
        files.push(DigestFile {
            path: relative(root, path),
            // Node normalizes CRLF so one declaration hashes the same in any checkout.
            text: text.map(|text| text.replace("\r\n", "\n")),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let input = DigestInput {
        version: DIGEST_VERSION,
        plugin_root,
        files,
    };
    let json = serde_json::to_vec(&input).ok()?;
    Some(format!("{:x}", Sha256::digest(&json)))
}

/// Node `referencedPaths`: strings, nested arrays walked, paths outside the root dropped (`resolveInside`).
fn referenced(root: &Path, spec: &Value, paths: &mut BTreeSet<PathBuf>) {
    match spec {
        Value::Array(items) => items.iter().for_each(|item| referenced(root, item, paths)),
        Value::String(raw) => {
            if let Some(path) = resolve_inside(root, raw) {
                paths.insert(path);
            }
        }
        _ => {}
    }
}

/// Node `resolveInside`.
fn resolve_inside(root: &Path, raw: &str) -> Option<PathBuf> {
    let raw = Path::new(raw);
    if raw.is_absolute() {
        return None;
    }
    let resolved = normalize(&root.join(raw));
    let rel = relative(root, &resolved);
    let inside = rel == "." || (!rel.starts_with("..") && !rel.contains("../"));
    inside.then_some(resolved)
}

/// Node `relative(from, to)` with `/` separators, `.` for the same path (`workspacePluginRootKey`; a digest entry
/// equal to the root would be `""` in Node, which no real file path produces).
fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<Component<'_>> = from.components().collect();
    let to: Vec<Component<'_>> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_owned(), from.len() - common).collect();
    parts.extend(
        to[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    }
}

/// Node `readTextIfExists` with `readFile(path, "utf8")`: missing (ENOENT, ENOTDIR) is `None`, other errors fail.
async fn read_text(path: &Path) -> std::io::Result<Option<String>> {
    match rust_cli_fs::read_optional(path).await {
        Ok(bytes) => Ok(bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == ErrorKind::NotADirectory => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "workspace_plugins_tests.rs"]
mod tests;
