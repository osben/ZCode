//! Import construction for amend-resume (Node `bootstrap/src/app/dynamic-workflow-import.ts`; specs/fork-rust-workflow-engine.md section 9.5).
//!
//! Reads the predecessor journal (the port's read methods only) and builds an [`ImportedRunCache`]. Three
//! gates reject the whole predecessor, in order: missing run, nonterminal run, and any completed ask without a
//! message boundary. Each actor degrades on its own: no persona, no transcript source, a short source, or
//! a duplicate name drops that actor's candidate and the actor runs live.
//!
//! The transcript message count (Node `countSource`) is injected as a function. `None` from it means the read
//! failed, which Node treats as an unusable source. Passing no function means there is no transcript surface,
//! and Node then keeps every candidate without the count check.
//!
//! Deviations: Node logs the degraded cases through a logger port; this port returns the reasons as values
//! and logs nothing.
use crate::imported_cache::{
    ImportedActorCandidate, ImportedAskEntry, ImportedInFlightAsk, ImportedRunCache,
    ImportedWorldEntry,
};
use crate::journal::JournalPort;
use crate::model::{ActorRow, NodeKind, NodeRow, NodeStatus, RunRow, RunStatus};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Why a predecessor cannot be imported (Node `ImportedCacheRefusalReason`). The discriminants are the
/// strings the port's refusal reasons carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportRefusal {
    RunNotFound,
    NotAmendable,
    MissingBoundaries,
}

impl ImportRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunNotFound => "run_not_found",
            Self::NotAmendable => "not_amendable",
            Self::MissingBoundaries => "missing_boundaries",
        }
    }
}

/// The result of building the cache: the table and the lineage pointer, or the refusal.
#[derive(Debug, Clone, PartialEq)]
pub enum BuildOutcome {
    Built {
        cache: ImportedRunCache,
        resumed_from: String,
    },
    Refused(ImportRefusal),
}

/// The transcript message count of a session (Node `countSource`): `None` when the read fails.
pub type TranscriptCount<'a> = &'a dyn Fn(&str) -> Option<u64>;

/// Options of one build (Node `AmendImportOptions` and the deps' transcript surface).
#[derive(Default, Clone, Copy)]
pub struct BuildOptions<'a> {
    /// Message count of a session, `None` when the read fails. Absent: no transcript surface.
    pub count: Option<TranscriptCount<'a>>,
    /// Sessions that have finished writing. Absent means all quiet (Node's omission rule).
    pub quiet_sessions: Option<&'a HashSet<String>>,
}

/// Node `preflightAmendImport`: the predecessor exists and every completed ask has a boundary. The status is
/// not checked, because stopping the predecessor happens only after this passes.
pub fn preflight_amend_import<J: JournalPort>(
    journal: &J,
    predecessor_run_id: &str,
) -> Result<Result<RunRow, ImportRefusal>> {
    let Some(run) = journal.get_run(predecessor_run_id)? else {
        return Ok(Err(ImportRefusal::RunNotFound));
    };
    let asks: Vec<NodeRow> = journal
        .list_nodes(predecessor_run_id)?
        .into_iter()
        .filter(|row| row.kind == NodeKind::Ask)
        .collect();
    if !completed_asks_have_boundaries(&asks) {
        return Ok(Err(ImportRefusal::MissingBoundaries));
    }
    Ok(Ok(run))
}

/// Node `buildImportedCache`: read the predecessor journal into a table. Deterministic for a given journal
/// and options.
pub fn build_imported_cache<J: JournalPort>(
    journal: &J,
    predecessor_run_id: &str,
    options: BuildOptions<'_>,
) -> Result<BuildOutcome> {
    let Some(run) = journal.get_run(predecessor_run_id)? else {
        return Ok(BuildOutcome::Refused(ImportRefusal::RunNotFound));
    };
    // Any terminal state is amendable (Node TERMINAL_RUN_STATUSES: completed, errored, stopped).
    if !matches!(
        run.status,
        RunStatus::Completed | RunStatus::Errored | RunStatus::Stopped
    ) {
        return Ok(BuildOutcome::Refused(ImportRefusal::NotAmendable));
    }
    let nodes: Vec<NodeRow> = journal
        .list_nodes(predecessor_run_id)?
        .into_iter()
        .filter(|row| {
            matches!(
                row.kind,
                NodeKind::Ask | NodeKind::WorldRead | NodeKind::WorldRun
            )
        })
        .collect();
    if !completed_asks_have_boundaries(&nodes) {
        return Ok(BuildOutcome::Refused(ImportRefusal::MissingBoundaries));
    }
    let asks_by_actor = group_asks_by_actor(&nodes);
    let mut actors = BTreeMap::new();
    for record in named_unique_actors(journal.list_actors(predecessor_run_id)?) {
        let name = record.name.clone().unwrap_or_default();
        let asks = asks_by_actor
            .get(&actor_key(&record.site_id, record.ordinal))
            .map_or(&[][..], Vec::as_slice);
        if let Some(candidate) =
            build_actor_candidate(journal, predecessor_run_id, &record, asks, options)?
        {
            actors.insert(name, candidate);
        }
    }
    Ok(BuildOutcome::Built {
        cache: ImportedRunCache {
            actors,
            world: build_world_queues(&nodes),
        },
        resumed_from: predecessor_run_id.to_owned(),
    })
}

/// Node `rebuildImportedCacheForResume`: the same table on resume. A failed build is not a refusal of
/// resume (the run stays resumable without the cache), so this returns `None`.
pub fn rebuild_imported_cache_for_resume<J: JournalPort>(
    journal: &J,
    predecessor_run_id: &str,
    options: BuildOptions<'_>,
) -> Result<Option<ImportedRunCache>> {
    // Node passes no quiet set on resume: the predecessor is terminal and nothing writes its sessions, and
    // omission means every session is quiet. The transcript count is kept.
    let options = BuildOptions {
        quiet_sessions: None,
        ..options
    };
    Ok(
        match build_imported_cache(journal, predecessor_run_id, options)? {
            BuildOutcome::Built { cache, .. } => Some(cache),
            BuildOutcome::Refused(_) => None,
        },
    )
}

/// Node `completedAsksHaveBoundaries`: every completed ask row carries a boundary.
fn completed_asks_have_boundaries(nodes: &[NodeRow]) -> bool {
    nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Ask && node.status == NodeStatus::Completed)
        .all(|node| node.message_boundary.is_some())
}

/// Node `namedUniqueActors`: named actors whose name occurs once in the run, in first-occurrence order.
/// Duplicates are dropped together, so neither actor can be matched by name.
fn named_unique_actors(records: Vec<ActorRow>) -> Vec<ActorRow> {
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<ActorRow>> = HashMap::new();
    for record in records {
        let Some(name) = record.name.clone().filter(|name| !name.is_empty()) else {
            continue;
        };
        if !buckets.contains_key(&name) {
            order.push(name.clone());
        }
        buckets.entry(name).or_default().push(record);
    }
    order
        .into_iter()
        .filter_map(|name| {
            let mut bucket = buckets.remove(&name)?;
            (bucket.len() == 1).then(|| bucket.remove(0))
        })
        .collect()
}

/// Node `buildActorCandidate`: the importable prefix of one actor, or `None` (the actor runs live).
fn build_actor_candidate<J: JournalPort>(
    journal: &J,
    predecessor_run_id: &str,
    actor: &ActorRow,
    asks: &[NodeRow],
    options: BuildOptions<'_>,
) -> Result<Option<ImportedActorCandidate>> {
    let Some(persona) = actor.persona.clone() else {
        return Ok(None);
    };
    let name = actor.name.clone().unwrap_or_default();
    let (entries, next) = completed_ask_prefix(asks)?;
    if entries.is_empty() && next.is_none_or(|row| row.status != NodeStatus::Running) {
        return Ok(None);
    }
    let Some(source) = resolve_transcript_source(journal, &name, predecessor_run_id)? else {
        return Ok(None);
    };
    let boundary = entries.last().map_or(0, |entry| entry.message_boundary);
    let message_count = match options.count {
        None => None,
        Some(count) => match count(&source.session_id) {
            // A failed read, or a session shorter than the prefix, drops the candidate at build time.
            Some(total) if total >= boundary => Some(total),
            _ => return Ok(None),
        },
    };
    let in_flight = resolve_in_flight_ask(
        actor,
        boundary,
        message_count,
        next,
        options.quiet_sessions,
        &source.session_id,
    );
    if entries.is_empty() && in_flight.is_none() {
        return Ok(None);
    }
    Ok(Some(ImportedActorCandidate {
        persona,
        entries,
        in_flight,
        transcript_source_session_id: source.session_id,
        resolved_model: source.resolved_model,
    }))
}

/// Node `resolveInFlightAsk`: the row right after the prefix is continued only when it is running, the
/// source is the predecessor's own session, the count is known, the session is quiet, and the count is
/// beyond the prefix boundary.
fn resolve_in_flight_ask(
    actor: &ActorRow,
    boundary: u64,
    message_count: Option<u64>,
    next: Option<&NodeRow>,
    quiet_sessions: Option<&HashSet<String>>,
    source_session_id: &str,
) -> Option<ImportedInFlightAsk> {
    let next = next.filter(|row| row.status == NodeStatus::Running)?;
    if actor.session_id.as_deref() != Some(source_session_id) {
        return None;
    }
    let message_count = message_count?;
    if let Some(quiet) = quiet_sessions
        && !quiet.contains(source_session_id)
    {
        return None;
    }
    if message_count <= boundary {
        return None;
    }
    Some(ImportedInFlightAsk {
        input_hash: next.input_hash.clone(),
        message_boundary: message_count,
    })
}

/// Node `completedAskPrefix`: the longest run of completed asks from seq 0, and the row that stopped it.
/// The rows are the actor's asks in journal order; a later row for the same seq replaces an earlier one, as
/// Node's map does.
fn completed_ask_prefix(asks: &[NodeRow]) -> Result<(Vec<ImportedAskEntry>, Option<&NodeRow>)> {
    let mut by_seq: HashMap<u64, &NodeRow> = HashMap::new();
    for node in asks {
        if let Some(seq) = node.actor_seq {
            by_seq.insert(seq, node);
        }
    }
    let mut entries = Vec::new();
    let mut seq = 0_u64;
    loop {
        let node = by_seq.get(&seq).copied();
        match node {
            Some(node) if node.status == NodeStatus::Completed => {
                let Some(message_boundary) = node.message_boundary else {
                    bail!(
                        "completed ask at actor sequence {seq} has no message boundary (the boundary gate should have refused this journal)"
                    );
                };
                entries.push(ImportedAskEntry {
                    input_hash: node.input_hash.clone(),
                    result: node.result.clone().unwrap_or(Value::Null),
                    stats: node.stats.clone(),
                    message_boundary,
                });
                seq += 1;
            }
            other => return Ok((entries, other)),
        }
    }
}

struct TranscriptSource {
    session_id: String,
    resolved_model: Option<String>,
}

/// Node `resolveTranscriptSource`: the nearest run in the `resumed_from` chain whose row for this actor
/// has a session. Session and model come from the same row. A name that occurs more than once in a run
/// is no source.
fn resolve_transcript_source<J: JournalPort>(
    journal: &J,
    actor_name: &str,
    start_run_id: &str,
) -> Result<Option<TranscriptSource>> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut run_id = Some(start_run_id.to_owned());
    while let Some(current) = run_id.take() {
        if !seen.insert(current.clone()) {
            break;
        }
        let matches: Vec<ActorRow> = journal
            .list_actors(&current)?
            .into_iter()
            .filter(|row| row.name.as_deref() == Some(actor_name))
            .collect();
        if matches.len() != 1 {
            return Ok(None);
        }
        let actor = &matches[0];
        if let Some(session_id) = &actor.session_id {
            return Ok(Some(TranscriptSource {
                session_id: session_id.clone(),
                resolved_model: actor.resolved_model.clone(),
            }));
        }
        run_id = journal.get_run(&current)?.and_then(|run| run.resumed_from);
    }
    Ok(None)
}

/// Node `groupAsksByActor`: the ask rows of each actor, in journal order.
fn group_asks_by_actor(nodes: &[NodeRow]) -> HashMap<String, Vec<NodeRow>> {
    let mut groups: HashMap<String, Vec<NodeRow>> = HashMap::new();
    for node in nodes {
        if node.kind != NodeKind::Ask {
            continue;
        }
        let (Some(site), Some(ordinal)) = (&node.actor_site_id, node.actor_ordinal) else {
            continue;
        };
        groups
            .entry(actor_key(site, ordinal))
            .or_default()
            .push(node.clone());
    }
    groups
}

/// Node `actorKey`: `site@ordinal`, the same shape as the engine's `refToString`.
fn actor_key(site_id: &str, ordinal: u64) -> String {
    format!("{site_id}@{ordinal}")
}

/// Node `buildWorldQueues`: completed world rows, keyed by input hash, in journal order.
fn build_world_queues(nodes: &[NodeRow]) -> BTreeMap<String, Vec<ImportedWorldEntry>> {
    let mut world: BTreeMap<String, Vec<ImportedWorldEntry>> = BTreeMap::new();
    for node in nodes {
        if !matches!(node.kind, NodeKind::WorldRead | NodeKind::WorldRun)
            || node.status != NodeStatus::Completed
        {
            continue;
        }
        world
            .entry(node.input_hash.clone())
            .or_default()
            .push(ImportedWorldEntry {
                input_hash: node.input_hash.clone(),
                kind: node.kind,
                result: node.result.clone().unwrap_or(Value::Null),
            });
    }
    world
}

/// The refusal as Node's preflight reports it: `{ok: true, run}` or `{ok: false, reason}`.
pub fn preflight_json(outcome: &Result<RunRow, ImportRefusal>) -> Value {
    match outcome {
        Ok(run) => json!({"ok": true, "run": run.to_json()}),
        Err(reason) => json!({"ok": false, "reason": reason.as_str()}),
    }
}

/// The build result as Node's golden records it: `{ok: true, cache, resumedFrom}` or `{ok: false, reason}`.
pub fn build_json(outcome: &BuildOutcome) -> Value {
    match outcome {
        BuildOutcome::Built {
            cache,
            resumed_from,
        } => json!({"ok": true, "cache": cache.to_json(), "resumedFrom": resumed_from}),
        BuildOutcome::Refused(reason) => json!({"ok": false, "reason": reason.as_str()}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_duplicate_name_drops_both_actors() {
        let row = |ordinal: u64, name: &str| ActorRow {
            run_id: "r".into(),
            site_id: "a".into(),
            ordinal,
            name: Some(name.into()),
            persona: Some(json!({"name": name})),
            session_id: None,
            resolved_model: None,
        };
        let kept = named_unique_actors(vec![row(1, "x"), row(2, "x"), row(3, "y")]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].name.as_deref(), Some("y"));
    }
}
