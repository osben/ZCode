//! Fork: the App's workspace hook review (specs/fork-rust-agent-parity.md, "Workspace hook review flow"): the bundle
//! with its stored trust, the grants and revocations of a review, and the configured `enabled` toggle (Node
//! `createWorkspaceHookReviewMutationPort` + `writeWorkspaceHookConfiguredToggle`). The flow itself belongs to the
//! protocol (`rust-cli-protocol-zcode` `fork/hook_review.rs`).
//!
//! Every call rediscovers the bundle, so a grant or a write is about the declarations on disk now; one that no longer
//! matches what the review showed writes nothing.

use rust_cli_hooks::node_config::{NODE_EVENTS, NodeHookKind, NodeHooks};
use rust_cli_hooks::workspace_digest::{self, DigestEntry, DigestSource};
use rust_cli_kernel_api::env::{EnvError, OperationContext, Origin, ReadFile, WritePrecondition};
use rust_cli_kernel_api::env_files::PutFile;
use rust_cli_kernel_api::ids::{Generation, OperationId};
use rust_cli_platform::local::{TrustError, TrustLoad, TrustRecord, node_pretty};
use rust_cli_protocol_zcode::hook_review_codes as codes;
use rust_cli_protocol_zcode::{
    ReviewBundle, ReviewItem, ReviewLookup, ReviewSource, StoredTrust, ToggleError,
};

use super::*;
use crate::commands::hooks_trust::{Failures, HookSourceFile};
use crate::config::trust::WorkspaceHooks;

/// The only kind of file the review writes.
const EDITABLE_KIND: &str = ".zcode/config.json";

impl AppWorkspace {
    /// The workspace's hooks as discovered now, the config files that cannot be loaded, and the loaded files that
    /// declare hooks.
    async fn review_hooks(
        &self,
        trust: &Target,
    ) -> (WorkspaceHooks, Failures, Vec<HookSourceFile>) {
        let context = TrustContext {
            files: self.files.as_ref(),
            paths: &self.paths,
            cwd: &trust.working_directory,
            version: self.version,
            now_ms: self.clock.now_ms(),
        };
        let identity = (trust.identity != trust.working_directory).then(|| trust.identity.clone());
        hooks_trust::inspect_review(&context, trust.working_directory.clone(), identity).await
    }

    /// Rebuilds the project hook entry of the workspace a trust change is about, wherever the process runs.
    pub(super) async fn rebuild_hooks(&self, trust: &Target) {
        let workspace = WorkspaceRef {
            environment: self.process.workspace.environment.clone(),
            root: EnvPath::new(trust.working_directory.clone()),
        };
        let identity = (trust.identity != trust.working_directory).then(|| trust.identity.clone());
        let entry = crate::config::project_hooks::entry(
            self.files.as_ref(),
            &self.paths,
            &workspace,
            identity,
        )
        .await;
        tracing::info!(
            event = "workspace.hooks.rebuilt",
            "the workspace's project hook entry was rebuilt"
        );
        (self.put_project_hooks)(rust_cli_hooks::project_key(&trust.working_directory), entry);
    }

    pub(super) async fn review_bundle(&self, target: &WorkspaceTarget) -> ReviewLookup {
        let trust = Self::trust_target(target);
        let (hooks, failures, sources) = self.review_hooks(&trust).await;
        // Like Node's session snapshot (`config-factory.ts`, `hookCandidates` from loaded files only), a project file
        // that cannot be loaded is skipped. An unreadable user config could name another store: fail closed.
        if failures.user {
            return ReviewLookup::Unreadable;
        }
        let Some(bundle) = hooks.bundle.as_ref() else {
            return ReviewLookup::Nothing;
        };
        let trusted = hooks.trusted();
        let records: &[TrustRecord] = match &hooks.load {
            TrustLoad::Records(records) => records,
            TrustLoad::Missing | TrustLoad::Corrupt => &[],
        };
        let items = bundle
            .entries
            .iter()
            .map(|entry| {
                let stored = if trusted.contains(&entry.digest) {
                    StoredTrust::Trusted
                } else if stale_slot(records, &hooks.identity, entry) {
                    StoredTrust::StaleSlot
                } else {
                    StoredTrust::Untrusted
                };
                review_item(entry, hooks.root.max_output_bytes, stored)
            })
            .collect();
        ReviewLookup::Bundle(ReviewBundle {
            identity: hooks.identity.clone(),
            bundle_digest: bundle.bundle_digest.clone(),
            sources: sources
                .iter()
                .map(|source| ReviewSource {
                    path: source.path.clone(),
                    display_path: display_path(&source.path),
                    editable: source.editable,
                })
                .collect(),
            items,
            store_corrupt: matches!(hooks.load, TrustLoad::Corrupt),
        })
    }

    pub(super) async fn review_grant(
        &self,
        target: &WorkspaceTarget,
        bundle_digest: &str,
        review_item_ids: &[String],
    ) -> Result<(), &'static str> {
        let trust = Self::trust_target(target);
        let (hooks, failures, _) = self.review_hooks(&trust).await;
        let selected = current_items(&hooks, failures.user, bundle_digest, review_item_ids)?;
        let context = TrustContext {
            files: self.files.as_ref(),
            paths: &self.paths,
            cwd: &trust.working_directory,
            version: self.version,
            now_ms: self.clock.now_ms(),
        };
        hooks
            .store
            .grant(hooks_trust::records(&hooks, &selected, &context))
            .await
            .map_err(|error| {
                tracing::warn!(
                    reason = trust_error_reason(&error),
                    "workspace hook review grant failed"
                );
                codes::TRUST_STORE_CORRUPT
            })?;
        self.rebuild_hooks(&trust).await;
        Ok(())
    }

    pub(super) async fn review_revoke(
        &self,
        target: &WorkspaceTarget,
        digests: &[String],
    ) -> Result<(), &'static str> {
        let trust = Self::trust_target(target);
        let (hooks, failures, _) = self.review_hooks(&trust).await;
        // An unreadable user config could name another store: write nothing.
        if failures.user {
            return Err(codes::SNAPSHOT_MISMATCH);
        }
        hooks
            .store
            .revoke(&hooks.identity, Some(digests))
            .await
            .map_err(|error| {
                tracing::warn!(
                    reason = trust_error_reason(&error),
                    "workspace hook review revoke failed"
                );
                codes::TRUST_STORE_CORRUPT
            })?;
        self.rebuild_hooks(&trust).await;
        Ok(())
    }

    pub(super) async fn review_toggle(
        &self,
        target: &WorkspaceTarget,
        bundle_digest: &str,
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), ToggleError> {
        // Node `withWorkspaceMutationLock`: one config write at a time.
        let Ok(_write) = self.toggles.acquire().await else {
            return Err(ToggleError::Rejected(codes::CONFIG_WRITE_FAILED));
        };
        let trust = Self::trust_target(target);
        let (hooks, failures, sources) = self.review_hooks(&trust).await;
        // Node `rebuildSnapshot` (`readWorkspaceHookProjectSources`) fails on any file that cannot be loaded.
        if failures.any() {
            return Err(ToggleError::Rejected(codes::CONFIG_UNREADABLE));
        }
        let Some(bundle) = hooks.bundle.as_ref() else {
            return Err(ToggleError::Rejected(codes::SNAPSHOT_MISMATCH));
        };
        if bundle.bundle_digest != bundle_digest {
            return Err(ToggleError::Rejected(codes::BUNDLE_CHANGED));
        }
        self.write_toggle(&trust, &hooks, &sources, review_item_id, enabled)
            .await
            .map_err(ToggleError::Rejected)?;
        let (after, failures, _) = self.review_hooks(&trust).await;
        self.rebuild_hooks(&trust).await;
        if failures.any() || after.bundle.is_none() {
            return Err(ToggleError::RebuildFailed);
        }
        Ok(())
    }

    /// Node `writeWorkspaceHookConfiguredToggle`: the declaration must still be the reviewed one in the editable
    /// `.zcode/config.json`; only its `enabled` changes. The write is conditional on the version read, so a config
    /// edited meanwhile is not overwritten.
    async fn write_toggle(
        &self,
        trust: &Target,
        hooks: &WorkspaceHooks,
        sources: &[HookSourceFile],
        review_item_id: &str,
        enabled: bool,
    ) -> Result<(), &'static str> {
        let entry = hooks
            .entries()
            .iter()
            .find(|entry| entry.review_item_id == review_item_id)
            .ok_or(codes::SNAPSHOT_MISMATCH)?;
        let source = sources
            .get(entry.source_index)
            .ok_or(codes::SNAPSHOT_MISMATCH)?;
        // `editable` is set only on `<workspace>/.zcode/config.json` (Node `editableConfigPath`).
        if !entry.editable || !source.editable || source.kind != EDITABLE_KIND {
            return Err(codes::SNAPSHOT_MISMATCH);
        }
        let workspace = WorkspaceRef {
            environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
            root: EnvPath::new(trust.working_directory.as_str()),
        };
        let path = EnvPath::new(source.path.as_str());
        let read = self
            .files
            .read_file(&workspace, ReadFile { path: path.clone() })
            .await
            .map_err(|error| {
                // The error messages carry paths, so only the variant is logged.
                tracing::warn!(
                    reason = env_error_reason(&error),
                    "the workspace hook config could not be read for a toggle"
                );
                codes::CONFIG_UNREADABLE
            })?;
        let mut raw: Value = serde_json::from_slice(&read.bytes).map_err(|error| {
            tracing::warn!(
                line = error.line(),
                column = error.column(),
                "the workspace hook config could not be parsed for a toggle"
            );
            codes::CONFIG_UNREADABLE
        })?;
        // The file may have changed since the review read it. Node re-parses `hooks` with its strict schema and
        // answers a mismatch (`workspace-hook-mutation.ts` `safeParse`); a missing `hooks` fails that parse too.
        let schema = raw
            .get("hooks")
            .map_or(Err(String::new()), crate::config::workspace_schema::check);
        if schema.is_err() {
            tracing::warn!("the workspace hook config no longer matches the schema for a toggle");
            return Err(codes::SNAPSHOT_MISMATCH);
        }
        if !declared_as_reviewed(&raw, entry, source, hooks) {
            return Err(codes::SNAPSHOT_MISMATCH);
        }
        let declaration = raw
            .get_mut("hooks")
            .and_then(|hooks| hooks.get_mut("events"))
            .and_then(|events| events.get_mut(entry.event.as_str()))
            .and_then(|matchers| matchers.get_mut(entry.matcher_index))
            .and_then(|matcher| matcher.get_mut("hooks"))
            .and_then(|list| list.get_mut(entry.hook_index))
            .and_then(Value::as_object_mut)
            .ok_or(codes::SNAPSHOT_MISMATCH)?;
        declaration.insert("enabled".to_owned(), Value::Bool(enabled));
        let context = OperationContext::new(
            workspace.environment.clone(),
            Generation::new("app-hook-review"),
            OperationId::new(format!("hook-toggle-{:016x}", rust_cli_base::random::u64())),
            Origin::User { session: None },
        );
        let request = PutFile {
            path,
            bytes: format!("{}\n", node_pretty(&raw)).into_bytes(),
            precondition: WritePrecondition::Version(read.version),
            create_parents: false,
        };
        match self.files.put_file(&workspace, context, request).await {
            Ok(_) => Ok(()),
            Err(EnvError::PreconditionFailed { .. }) => Err(codes::BUNDLE_CHANGED),
            Err(error) => {
                tracing::warn!(
                    reason = env_error_reason(&error),
                    "workspace hook toggle write failed"
                );
                Err(codes::CONFIG_WRITE_FAILED)
            }
        }
    }
}

/// The selected declarations of the bundle on disk; `snapshot_mismatch` when it is not the reviewed bundle.
fn current_items(
    hooks: &WorkspaceHooks,
    unreadable: bool,
    bundle_digest: &str,
    review_item_ids: &[String],
) -> Result<Vec<usize>, &'static str> {
    let bundle = hooks
        .bundle
        .as_ref()
        .filter(|bundle| !unreadable && bundle.bundle_digest == bundle_digest)
        .ok_or(codes::SNAPSHOT_MISMATCH)?;
    review_item_ids
        .iter()
        .map(|id| {
            bundle
                .entries
                .iter()
                .position(|entry| &entry.review_item_id == id)
                .ok_or(codes::SNAPSHOT_MISMATCH)
        })
        .collect()
}

/// Node `writeWorkspaceHookConfiguredToggle`'s digest re-check: the declaration read now has the reviewed digest
/// (with the reviewed runtime defaults, as Node uses the entry's resolved values).
fn declared_as_reviewed(
    raw: &Value,
    entry: &DigestEntry,
    source: &HookSourceFile,
    hooks: &WorkspaceHooks,
) -> bool {
    let Some(value) = raw.as_object().and_then(|object| object.get("hooks")) else {
        return false;
    };
    let (mut parsed, warnings) = NodeHooks::from_json(value);
    // Node's strict schema rejects the whole object (`workspace-hook-mutation.ts` `safeParse`); the lenient parse
    // skipped entries instead, so the reviewed indices no longer name raw positions.
    if !warnings.is_empty() {
        return false;
    }
    parsed
        .events
        .retain(|(event, _)| NODE_EVENTS.contains(event));
    let digest_source = DigestSource {
        relative_path: entry.source_relative_path.clone(),
        discovery_order: source.order,
        kind: source.kind,
        explicit: false,
        editable: source.editable,
        hooks: &parsed,
    };
    workspace_digest::bundle(&[digest_source], &hooks.root).is_some_and(|bundle| {
        bundle.entries.iter().any(|current| {
            current.event == entry.event
                && current.matcher_index == entry.matcher_index
                && current.hook_index == entry.hook_index
                && current.digest == entry.digest
        })
    })
}

/// Node `isStaleSlot`: a record of the same workspace for the same slot (every `*AtGrant` slot field present) with
/// another digest.
fn stale_slot(records: &[TrustRecord], identity: &str, entry: &DigestEntry) -> bool {
    records.iter().any(|record| {
        record.workspace_identity == identity
            && record.hook_declaration_digest != entry.digest
            && record.event_at_grant == entry.event.as_str()
            && record.source_path_at_grant == entry.source_relative_path
            && record.source_discovery_order_at_grant == Some(entry.source_discovery_order as u64)
            && record.matcher_at_grant.as_ref() == Some(&entry.matcher)
            && record.matcher_index_at_grant == Some(entry.matcher_index as u64)
            && record.hook_index_at_grant == Some(entry.hook_index as u64)
    })
}

fn review_item(entry: &DigestEntry, max_output_bytes: f64, stored: StoredTrust) -> ReviewItem {
    let (kind, background) = match &entry.hook.kind {
        NodeHookKind::Command { background, .. } => ("command", *background),
        NodeHookKind::Process { .. } => ("process", false),
    };
    ReviewItem {
        review_item_id: entry.review_item_id.clone(),
        event: entry.event.as_str().to_owned(),
        matcher: entry.matcher.clone().filter(|matcher| !matcher.is_empty()),
        kind,
        display_command: entry.hook.display(),
        source_path: entry.source_relative_path.clone(),
        resolved_timeout_ms: positive_whole(entry.resolved_timeout_ms),
        resolved_max_output_bytes: positive_whole(max_output_bytes),
        background,
        configured_enabled: entry.configured_enabled,
        editable: entry.editable,
        digest: entry.digest.clone(),
        stored,
    }
}

// Like `env_error_reason`: an IO error or a record digest is not logged.
fn trust_error_reason(error: &TrustError) -> &'static str {
    match error {
        TrustError::Corrupt => "corrupt",
        TrustError::Invalid(_) => "invalid_record",
        TrustError::Io(_) => "io",
    }
}

// The messages carry paths: only the variant is logged.
fn env_error_reason(error: &EnvError) -> &'static str {
    match error {
        EnvError::NotFound { .. } => "not_found",
        EnvError::PreconditionFailed { .. } => "precondition_failed",
        EnvError::PermissionDenied { .. } => "permission_denied",
        EnvError::Stale { .. } => "stale",
        EnvError::OperationConflict { .. } => "operation_conflict",
        EnvError::Io { .. } => "io",
        EnvError::Unsupported { .. } => "unsupported",
    }
}

/// The resolved values are whole positive numbers (Node rounds them and keeps at least 1).
fn positive_whole(value: f64) -> u64 {
    if value.is_finite() && value >= 1.0 {
        value.round() as u64
    } else {
        1
    }
}

/// Node `relative(baseDir, canonicalPath) || basename(canonicalPath)`: `baseDir` is the folder that holds the
/// `.zcode` directory, or the file's own folder.
fn display_path(path: &str) -> String {
    let mut parts = path.rsplit(['/', '\\']).filter(|part| !part.is_empty());
    let name = parts.next().unwrap_or(path);
    match parts.next() {
        Some(".zcode") => {
            let separator = if path.contains('/') { '/' } else { '\\' };
            format!(".zcode{separator}{name}")
        }
        _ => name.to_owned(),
    }
}

#[cfg(test)]
#[path = "app_hook_review_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "app_hook_snapshot_tests.rs"]
mod snapshot_tests;
