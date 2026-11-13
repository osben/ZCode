//! Fork: the language-server preferences sidecar `<cliStorageRoot>/fork_lsp_preferences.json`
//! (specs/fork-rust-lsp.md "Preferences file"), Node bootstrap `app/lsp-preferences.ts`. The file is shared with Node:
//! the same strict shape, the same text and a same-directory rename, so either runtime reads what the other wrote.

use std::path::PathBuf;

use rust_cli_fs::{FileMode, ParentDir, TempName, WriteOptions};
use rust_cli_kernel_api::lsp::{LspPreferences, LspPreferencesPatch};
use serde_json::{Map, Value};
use tokio::sync::Semaphore;

const WRITE: WriteOptions = WriteOptions {
    mode: FileMode::Default,
    temp_name: TempName::Hidden,
    // Node `createParents: true`: a fresh storage root may not have `cli/` yet.
    parent: ParentDir::Create,
    rename_retry: rust_cli_fs::NODE_RENAME_RETRY,
};

/// The one owner of the sidecar in this process. Every call re-reads the file; nothing is cached.
pub(crate) struct PreferencesStore {
    path: PathBuf,
    /// Node's queue: one read-merge-write (or read) at a time in this process (a one-permit semaphore, the workspace's
    /// pattern for a turn held across `.await`).
    updates: Semaphore,
}

impl PreferencesStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            updates: Semaphore::new(1),
        }
    }

    /// Node `load`: a missing, unreadable or invalid file reads as the defaults; it never fails. It waits behind a
    /// running update, as Node's `load` runs on the update queue, so a read sent after a write sees it.
    pub(crate) async fn load(&self) -> LspPreferences {
        let _turn = self.updates.acquire().await.ok();
        match rust_cli_fs::read_optional(&self.path).await {
            Ok(Some(bytes)) => parse(&bytes),
            Ok(None) => LspPreferences::default(),
            Err(error) => {
                tracing::warn!(event = "lsp.preferences.unreadable", %error, "LSP preferences file unreadable; using defaults");
                LspPreferences::default()
            }
        }
    }

    /// Node `update`: merges onto the file as it is on disk (not found → defaults, invalid → defaults, any other read
    /// error fails the call and leaves the file alone), then writes it.
    pub(crate) async fn update(
        &self,
        patch: &LspPreferencesPatch,
    ) -> Result<LspPreferences, String> {
        let _turn = self
            .updates
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        let base = match rust_cli_fs::read_optional(&self.path).await {
            Ok(Some(bytes)) => parse(&bytes),
            Ok(None) => LspPreferences::default(),
            Err(error) => return Err(error.to_string()),
        };
        let next = apply(base, patch);
        rust_cli_fs::atomic_write(&self.path, text(&next).as_bytes(), WRITE)
            .await
            .map_err(|error| error.to_string())?;
        Ok(next)
    }
}

/// `LspPreferencesSchema` (strict): `{version: 1, enabled: bool, diagnosticsAfterEdit: record<bool>}`.
fn strict(value: &Value) -> Option<LspPreferences> {
    let object = value.as_object()?;
    if object.len() != 3 || object.get("version")?.as_f64()? != 1.0 {
        return None;
    }
    let enabled = object.get("enabled")?.as_bool()?;
    let overrides = object.get("diagnosticsAfterEdit")?.as_object()?;
    overrides
        .values()
        .all(Value::is_boolean)
        .then(|| LspPreferences {
            enabled,
            diagnostics_after_edit: overrides.clone(),
        })
}

pub(super) fn parse(bytes: &[u8]) -> LspPreferences {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        tracing::warn!(
            event = "lsp.preferences.invalid_json",
            "LSP preferences file is not valid JSON; using defaults"
        );
        return LspPreferences::default();
    };
    strict(&value).unwrap_or_else(|| {
        tracing::warn!(
            event = "lsp.preferences.invalid",
            "LSP preferences file failed schema validation; using defaults"
        );
        LspPreferences::default()
    })
}

/// Node `applyPatch`: an existing override keeps its place, a new one goes last, `null` removes one.
pub(super) fn apply(base: LspPreferences, patch: &LspPreferencesPatch) -> LspPreferences {
    let mut overrides: Map<String, Value> = base.diagnostics_after_edit;
    for (server, value) in &patch.diagnostics_after_edit {
        match value {
            Some(on) => {
                overrides.insert(server.clone(), Value::Bool(*on));
            }
            None => {
                overrides.shift_remove(server);
            }
        }
    }
    LspPreferences {
        enabled: patch.enabled.unwrap_or(base.enabled),
        diagnostics_after_edit: overrides,
    }
}

/// `JSON.stringify(record, null, 2) + "\n"`: keys in Node's order, and the overrides in JS property order (array-index
/// keys first, then insertion order), which `serde_json`'s pretty printer does not know.
pub(super) fn text(prefs: &LspPreferences) -> String {
    use rust_cli_base::js::json::{properties, write_str};
    let mut out = format!(
        "{{\n  \"version\": 1,\n  \"enabled\": {},\n  \"diagnosticsAfterEdit\": ",
        prefs.enabled
    );
    let mut entries = properties(&prefs.diagnostics_after_edit).peekable();
    if entries.peek().is_none() {
        out.push_str("{}");
    } else {
        out.push('{');
        let mut first = true;
        for (server, on) in entries {
            out.push_str(if first { "\n    " } else { ",\n    " });
            first = false;
            write_str(&mut out, server);
            out.push_str(": ");
            out.push_str(if on.as_bool() == Some(true) {
                "true"
            } else {
                "false"
            });
        }
        out.push_str("\n  }");
    }
    out.push_str("\n}\n");
    out
}
