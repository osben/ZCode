//! User-facing artifacts (Node `engine/engine-artifacts.ts`, `engine-artifacts-primary.ts`; spec 9.6).
//!
//! Terminology: an artifact here is a deliverable a script publishes, not the run's return value
//! (`RunSettlement::Completed`). Two families:
//! - content members (`file`, `markdown`) are effects: the host copies the bytes, so the publish is a ticket
//!   that settles when the host calls `artifact_publish_settled`;
//! - preset members (`chart`, `table`, `metrics`, `board`) are declarations: synchronous, no driver call.
//!
//! Each run has at most one primary artifact id, which is sticky: once an id is primary, its later versions
//! are too. Only completed rows claim an id, a kind, or a version on resume.
use crate::artifact_spec::validate_artifact_spec;
use crate::canon::{canonical_json, input_hash};
use crate::engine::{WorkflowDriver, WorkflowEngine};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref};
use crate::replay::{HeldSettle, Release};
use crate::scheduler::hash_mismatch;
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};

/// Node `ARTIFACT_CAPS`: the run-level limits on ids and versions.
pub const MAX_ARTIFACTS_PER_RUN: usize = 32;
pub const MAX_VERSIONS_PER_ARTIFACT: u64 = 16;

/// Content members, the effect family.
pub fn is_content_op(op: &str) -> bool {
    matches!(op, "file" | "markdown")
}

/// Preset members, the declaration family.
pub fn is_preset_op(op: &str) -> bool {
    matches!(op, "chart" | "table" | "metrics" | "board")
}

/// Node `ArtifactIdState`: what this run knows about one id. Rebuilt on resume from completed rows.
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactIdState {
    pub kind: String,
    /// Successful versions (a preset declaration is always one).
    pub versions: u64,
    /// Canonical JSON of a preset spec, to tell an idempotent re-declaration from a changed one.
    pub spec: Option<String>,
    pub primary: bool,
}

/// Node `ArtifactPublishRequest`: what the host copies. `path` for `file`, `content` for `markdown`.
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactPublishRequest {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: u64,
    pub op: String,
    pub id: String,
    pub version: u64,
    pub path: Option<String>,
    pub content: Option<String>,
    pub opts: Option<Value>,
}

impl ArtifactPublishRequest {
    /// The request as Node's object literal orders its keys.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("runId".into(), json!(self.run_id));
        map.insert("siteId".into(), json!(self.site_id));
        map.insert("ordinal".into(), json!(self.ordinal));
        map.insert("op".into(), json!(self.op));
        map.insert("id".into(), json!(self.id));
        map.insert("version".into(), json!(self.version));
        if let Some(path) = &self.path {
            map.insert("path".into(), json!(path));
        }
        if let Some(content) = &self.content {
            map.insert("content".into(), json!(content));
        }
        if let Some(opts) = &self.opts {
            map.insert("opts".into(), opts.clone());
        }
        Value::Object(map)
    }
}

/// A content publish the host has not settled yet, keyed by instance in the engine.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingPublish {
    pub ticket: u64,
    pub hash: String,
    pub id: String,
    pub op: String,
    pub version: u64,
    pub primary: bool,
}

/// Node `primaryConflictMessage`.
fn primary_conflict_message(id: &str, holder: &str, fix: &str, instance: Option<&Ref>) -> String {
    let location = instance.map_or(String::new(), |at| format!(" (at {})", at.key()));
    format!(
        "Cannot mark \"{id}\" as primary{location}: \"{holder}\" is already this run's primary artifact. \
         A run has one deliverable; {fix}, or publish it as a new version of \"{holder}\"."
    )
}

/// Node `presetRecord`: the title and description are lifted out of the spec for card readers. A declaration
/// is always version 1.
fn preset_record(id: &str, op: &str, spec: &Value) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), json!(id));
    map.insert("kind".into(), json!(op));
    map.insert("version".into(), json!(1));
    if let Some(title) = spec.get("title").and_then(Value::as_str) {
        map.insert("title".into(), json!(title));
    }
    if let Some(description) = spec.get("description").and_then(Value::as_str) {
        map.insert("description".into(), json!(description));
    }
    map.insert("spec".into(), spec.clone());
    if spec.get("primary") == Some(&Value::Bool(true)) {
        map.insert("primary".into(), json!(true));
    }
    Value::Object(map)
}

/// Node `{ ...record, primary: true }`: the flag keeps the record's position when the key is already there.
fn with_primary(mut record: Value) -> Value {
    if let Some(map) = record.as_object_mut() {
        map.insert("primary".into(), Value::Bool(true));
    }
    record
}

/// The id argument as Node checks it: a string that is not empty.
fn non_empty_id(args: &[Value]) -> Option<&str> {
    args.first()
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// The id holding the primary flag, if any (Node `primaryArtifactId`).
    fn primary_artifact_id(&self) -> Option<String> {
        self.artifacts
            .iter()
            .find(|(_, state)| state.primary)
            .map(|(id, _)| id.clone())
    }

    /// The holder of the primary flag when `id` wants it and another id holds it (Node `primaryConflict`).
    fn primary_conflict(&self, id: &str, primary: bool) -> Option<String> {
        if !primary {
            return None;
        }
        self.primary_artifact_id().filter(|holder| holder != id)
    }

    /// Whether `id` is a declared preset (a valid target for a report tag).
    pub(crate) fn is_declared_preset(&self, id: &str) -> bool {
        self.artifacts
            .get(id)
            .is_some_and(|state| is_preset_op(&state.kind))
    }

    /// Declared preset ids in JavaScript's default sort (UTF-16 code units), for the undeclared-tag message.
    pub(crate) fn declared_preset_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .artifacts
            .iter()
            .filter(|(_, state)| is_preset_op(&state.kind))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        ids
    }

    /// Node `admitArtifact`: kind ownership, primary, id limit, version limit. All four are node-level
    /// rejections, so the caller rejects the promise with the error.
    fn admit_artifact(&self, id: &str, op: &str, primary: bool) -> Option<WorkflowError> {
        let existing = self.artifacts.get(id);
        if let Some(state) = existing
            && state.kind != op
        {
            return Some(WorkflowError::new(
                ErrorCode::ArtifactKindMismatch,
                format!(
                    "Artifact id \"{id}\" is already a {} and cannot be published as a {op}. An id belongs to one artifact kind for the whole run (publishing the same id again creates a new version, and a version cannot change what it is); use a different id.",
                    state.kind
                ),
            ));
        }
        if let Some(holder) = self.primary_conflict(id, primary) {
            return Some(WorkflowError::new(
                ErrorCode::ArtifactPrimaryConflict,
                primary_conflict_message(
                    id,
                    &holder,
                    &format!("publish \"{id}\" without primary"),
                    None,
                ),
            ));
        }
        if existing.is_none() && self.artifacts.len() >= MAX_ARTIFACTS_PER_RUN {
            return Some(WorkflowError::new(
                ErrorCode::ArtifactCapExceeded,
                format!(
                    "Cannot publish \"{id}\": this run already has {MAX_ARTIFACTS_PER_RUN} artifact ids, the maximum. Publish a new version of an existing id instead."
                ),
            ));
        }
        if let Some(state) = existing
            && state.versions >= MAX_VERSIONS_PER_ARTIFACT
        {
            return Some(WorkflowError::new(
                ErrorCode::ArtifactVersionCapExceeded,
                format!(
                    "Artifact \"{id}\" already has {} versions, the maximum of {MAX_VERSIONS_PER_ARTIFACT}. Publish the final content in fewer versions.",
                    state.versions
                ),
            ));
        }
        None
    }

    /// Node `settleArtifactFailure`, writes only: the failed row and `artifact-failed`. The caller rejects.
    fn settle_artifact_failure(
        &mut self,
        instance: &Ref,
        hash: &str,
        id: &str,
        op: &str,
        error: &WorkflowError,
    ) -> Result<()> {
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: instance.site_id.clone(),
            ordinal: instance.ordinal,
            kind: NodeKind::Artifact,
            actor_site_id: None,
            actor_ordinal: None,
            actor_seq: None,
            input_hash: hash.to_owned(),
            status: NodeStatus::Failed,
            result: None,
            error: Some(error.to_json()),
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: Some(id.to_owned()),
        })?;
        self.record(RunEvent::ArtifactFailed {
            instance: instance.clone(),
            id: id.to_owned(),
            op: op.to_owned(),
            error: error.to_json(),
        })
    }

    /// Node `publishContentArtifact`: a `file` or `markdown` publish. Returns the ticket; the settlement comes
    /// later through `artifact_publish_settled` (live) or the replay gate (a recorded row).
    pub fn publish_artifact(&mut self, site_id: &str, op: &str, args: &[Value]) -> Result<u64> {
        let ticket = self.allocate_ticket();
        if self.is_settled() {
            let error = self.run_error();
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        }
        let ordinal = self.identity.next_ordinal(site_id);
        let instance = Ref::new(site_id, ordinal);
        // Deterministic argument refusals write no row and emit no event: a replay repeats them.
        let Some(id) = non_empty_id(args) else {
            let error = WorkflowError::new(
                ErrorCode::DriverError,
                format!(
                    "artifact.{op}: id must be a non-empty string (at {}).",
                    instance.key()
                ),
            );
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        };
        let id = id.to_owned();
        let payload = args.get(1).and_then(Value::as_str).map(str::to_owned);
        let Some(payload) = payload else {
            let message = if op == "file" {
                format!(
                    "artifact.file: path must be a string (at {}).",
                    instance.key()
                )
            } else {
                format!(
                    "artifact.markdown: content must be a string (at {}).",
                    instance.key()
                )
            };
            self.push_outcome(
                ticket,
                Err(WorkflowError::new(ErrorCode::DriverError, message)),
            );
            return Ok(ticket);
        };
        // Borrowed from the argument: only the flag is read here; the request keeps the whole value.
        let primary_option = args.get(2).and_then(|value| value.get("primary"));
        if let Some(value) = primary_option
            && !value.is_boolean()
        {
            let error = WorkflowError::new(
                ErrorCode::DriverError,
                format!(
                    "artifact.{op}: opts.primary must be a boolean (at {}).",
                    instance.key()
                ),
            );
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        }
        let hash = input_hash(&json!({"args": args, "id": id, "op": op}));

        if let Some(recorded) = self.journal.get_node(&self.run_id, &instance)? {
            if recorded.input_hash != hash {
                let error = hash_mismatch(&instance, &recorded.input_hash, &hash);
                self.fail_run(error.clone())?;
                self.push_outcome(ticket, Err(error));
                return Ok(ticket);
            }
            // A completed or failed row settles through the replay gate, as Node's `heldResolution` does.
            // A running row was interrupted mid-publish, so it falls through to a live publish.
            let settle = match recorded.status {
                NodeStatus::Completed => {
                    let record = recorded.result.unwrap_or(Value::Null);
                    Some(Ok(json!({
                        "id": record.get("id").cloned().unwrap_or(Value::Null),
                        "version": record.get("version").cloned().unwrap_or(Value::Null),
                    })))
                }
                NodeStatus::Failed => Some(Err(recorded
                    .error
                    .as_ref()
                    .and_then(WorkflowError::from_json)
                    .unwrap_or_else(|| {
                        WorkflowError::new(
                            ErrorCode::DriverError,
                            "Recorded artifact failure is unreadable.",
                        )
                    }))),
                NodeStatus::Running => None,
            };
            if let Some(outcome) = settle {
                self.hold_for_replay(&instance, Release::Held(HeldSettle { ticket, outcome }))?;
                return Ok(ticket);
            }
        }

        // Sticky: an id that is already primary keeps the flag whether or not `primary` is passed again.
        let existing = self.artifacts.get(&id).cloned();
        let primary = primary_option == Some(&Value::Bool(true))
            || existing.as_ref().is_some_and(|state| state.primary);
        if let Some(problem) = self.admit_artifact(&id, op, primary) {
            self.settle_artifact_failure(&instance, &hash, &id, op, &problem)?;
            self.push_outcome(ticket, Err(problem));
            return Ok(ticket);
        }
        let version = existing.as_ref().map_or(0, |state| state.versions) + 1;
        if !self.driver.has_artifact_store() {
            let error = WorkflowError::new(
                ErrorCode::ArtifactStoreUnavailable,
                format!(
                    "Cannot publish \"{id}\": this host has no artifact store (at {}).",
                    instance.key()
                ),
            );
            self.settle_artifact_failure(&instance, &hash, &id, op, &error)?;
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        }
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: site_id.to_owned(),
            ordinal,
            kind: NodeKind::Artifact,
            actor_site_id: None,
            actor_ordinal: None,
            actor_seq: None,
            input_hash: hash.clone(),
            status: NodeStatus::Running,
            result: None,
            error: None,
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: Some(id.clone()),
        })?;
        let request = ArtifactPublishRequest {
            run_id: self.run_id.clone(),
            site_id: site_id.to_owned(),
            ordinal,
            op: op.to_owned(),
            id: id.clone(),
            version,
            path: (op == "file").then(|| payload.clone()),
            content: (op != "file").then(|| payload.clone()),
            opts: args.get(2).cloned(),
        };
        self.pending_publishes.insert(
            instance.key(),
            PendingPublish {
                ticket,
                hash,
                id,
                op: op.to_owned(),
                version,
                primary,
            },
        );
        self.driver.start_artifact_publish(&instance, &request);
        Ok(ticket)
    }

    /// The host's answer to a publish (Node's `.then` on `executeArtifactPublish`). A record settles the ticket
    /// with `{id, version}`. A failure journals the failed row and `artifact-failed` and rejects the ticket, even
    /// when the run has settled since the publish started: Node's rejection path does the same. After settlement,
    /// a record writes nothing and rejects with the run error.
    pub fn artifact_publish_settled(
        &mut self,
        instance: &Ref,
        result: std::result::Result<Value, WorkflowError>,
    ) -> Result<()> {
        let Some(pending) = self.pending_publishes.remove(&instance.key()) else {
            bail!("no artifact publish is pending at {}", instance.key());
        };
        let PendingPublish {
            ticket,
            hash,
            id,
            op,
            version,
            primary,
        } = pending;
        let record = match result {
            Ok(record) => record,
            Err(error) => {
                self.settle_artifact_failure(instance, &hash, &id, &op, &error)?;
                self.push_outcome(ticket, Err(error));
                return Ok(());
            }
        };
        if self.is_settled() {
            let error = self.run_error();
            self.push_outcome(ticket, Err(error));
            return Ok(());
        }
        // Two publishes with the flag can both pass admission before either settles, so check again here.
        if let Some(holder) = self.primary_conflict(&id, primary) {
            let error = WorkflowError::new(
                ErrorCode::ArtifactPrimaryConflict,
                primary_conflict_message(
                    &id,
                    &holder,
                    &format!("publish \"{id}\" without primary"),
                    Some(instance),
                ),
            );
            self.settle_artifact_failure(instance, &hash, &id, &op, &error)?;
            self.push_outcome(ticket, Err(error));
            return Ok(());
        }
        let stored = if primary {
            with_primary(record)
        } else {
            record
        };
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: instance.site_id.clone(),
            ordinal: instance.ordinal,
            kind: NodeKind::Artifact,
            actor_site_id: None,
            actor_ordinal: None,
            actor_seq: None,
            input_hash: hash,
            status: NodeStatus::Completed,
            result: Some(stored.clone()),
            error: None,
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: Some(id.clone()),
        })?;
        self.artifacts.insert(
            id.clone(),
            ArtifactIdState {
                kind: op.clone(),
                versions: version,
                spec: None,
                primary,
            },
        );
        self.record(RunEvent::ArtifactPublished {
            instance: instance.clone(),
            artifact: stored,
        })?;
        self.push_outcome(ticket, Ok(json!({"id": id, "version": version})));
        Ok(())
    }

    /// Node `declarePresetArtifact`: a predeclared artifact. Void, so every refusal fails the run.
    pub fn declare_artifact(&mut self, site_id: &str, op: &str, args: &[Value]) -> Result<()> {
        if self.is_settled() {
            return Ok(());
        }
        let ordinal = self.identity.next_ordinal(site_id);
        let instance = Ref::new(site_id, ordinal);
        let Some(id) = non_empty_id(args) else {
            let error = WorkflowError::new(
                ErrorCode::DriverError,
                format!(
                    "artifact.{op}: id must be a non-empty string (at {}).",
                    instance.key()
                ),
            );
            return self.fail_run(error);
        };
        let id = id.to_owned();
        let spec = args.get(1);
        let hash = input_hash(&json!({"args": args, "id": id, "op": op}));
        if let Some(recorded) = self.journal.get_node(&self.run_id, &instance)? {
            if recorded.input_hash != hash {
                return self.fail_run(hash_mismatch(&instance, &recorded.input_hash, &hash));
            }
            // Replay deduplication: the declaration already happened in an earlier lifetime.
            return Ok(());
        }
        if let Some(problem) = validate_artifact_spec(op, spec) {
            let error = WorkflowError::new(
                ErrorCode::ArtifactSpecInvalid,
                format!(
                    "Artifact \"{id}\" has an invalid spec (at {}): {problem}",
                    instance.key()
                ),
            );
            return self.fail_run(error);
        }
        // A valid spec is an object: the validator refuses anything else first.
        let spec = spec.unwrap_or(&Value::Null);
        let canonical = canonical_json(spec);
        if let Some(state) = self.artifacts.get(&id).cloned() {
            if state.kind != op {
                let error = WorkflowError::new(
                    ErrorCode::ArtifactKindMismatch,
                    format!(
                        "Artifact id \"{id}\" is already a {} and cannot be declared as a {op} (at {}). An id belongs to one artifact kind for the whole run; use a different id.",
                        state.kind,
                        instance.key()
                    ),
                );
                return self.fail_run(error);
            }
            if state.spec.as_deref() == Some(canonical.as_str()) {
                // Idempotent: no row and no event.
                return Ok(());
            }
            let error = WorkflowError::new(
                ErrorCode::ArtifactRedeclared,
                format!(
                    "Artifact \"{id}\" was already declared with a different spec (at {}). The spec for one id must stay identical (an identical re-declaration is a no-op); declare it once at the top of the script.",
                    instance.key()
                ),
            );
            return self.fail_run(error);
        }
        // `primary` is part of the canonical spec, so only a new id can conflict here.
        let wants_primary = spec.get("primary") == Some(&Value::Bool(true));
        if wants_primary
            && let Some(holder) = self.primary_artifact_id()
            && holder != id
        {
            let error = WorkflowError::new(
                ErrorCode::ArtifactPrimaryConflict,
                primary_conflict_message(
                    &id,
                    &holder,
                    &format!("declare \"{id}\" without primary"),
                    Some(&instance),
                ),
            );
            return self.fail_run(error);
        }
        if self.artifacts.len() >= MAX_ARTIFACTS_PER_RUN {
            let error = WorkflowError::new(
                ErrorCode::ArtifactCapExceeded,
                format!(
                    "Cannot declare \"{id}\": this run already has {MAX_ARTIFACTS_PER_RUN} artifact ids, the maximum. Reuse an existing id or publish fewer artifacts."
                ),
            );
            return self.fail_run(error);
        }
        let record = preset_record(&id, op, spec);
        self.artifacts.insert(
            id.clone(),
            ArtifactIdState {
                kind: op.to_owned(),
                versions: 1,
                spec: Some(canonical),
                primary: wants_primary,
            },
        );
        self.journal.put_node(NodeRow {
            run_id: self.run_id.clone(),
            site_id: site_id.to_owned(),
            ordinal,
            kind: NodeKind::Artifact,
            actor_site_id: None,
            actor_ordinal: None,
            actor_seq: None,
            input_hash: hash,
            status: NodeStatus::Completed,
            result: Some(record.clone()),
            error: None,
            stats: None,
            input: None,
            message_boundary: None,
            artifact_id: Some(id),
        })?;
        self.record(RunEvent::ArtifactPublished {
            instance,
            artifact: record,
        })
    }

    /// Node `rememberArtifactRow`, over the completed artifact rows on resume: the id's kind, spec, version
    /// count and primary flag. Failed rows claim nothing.
    ///
    /// Record contract at the `Value` boundary: `result` is the record this engine stored. A content version is the
    /// driver's record with `kind`; a preset declaration is `preset_record` with `kind` and `spec`. A completed row
    /// without a string `kind` is not a record this engine writes: it is skipped with a warning (Node skips it
    /// silently), so a corrupt row cannot claim an id.
    pub(crate) fn restore_artifacts(&mut self, rows: &[NodeRow]) {
        for row in rows.iter().filter(|row| row.kind == NodeKind::Artifact) {
            if row.status != NodeStatus::Completed {
                continue;
            }
            let (Some(id), Some(result)) = (row.artifact_id.as_deref(), row.result.as_ref()) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let Some(kind) = result.get("kind").and_then(Value::as_str) else {
                tracing::warn!(
                    run_id = %self.run_id,
                    artifact_id = id,
                    "completed artifact row has no kind; not restored"
                );
                continue;
            };
            let existing = self.artifacts.get(id).cloned();
            let spec = match result.get("spec") {
                Some(spec) => Some(canonical_json(spec)),
                None => existing.as_ref().and_then(|state| state.spec.clone()),
            };
            let primary = result.get("primary") == Some(&Value::Bool(true))
                || existing.as_ref().is_some_and(|state| state.primary);
            let versions = existing.as_ref().map_or(0, |state| state.versions) + 1;
            self.artifacts.insert(
                id.to_owned(),
                ArtifactIdState {
                    kind: kind.to_owned(),
                    versions,
                    spec,
                    primary,
                },
            );
        }
    }
}
