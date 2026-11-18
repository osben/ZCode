//! The amend-resume import cache (Node `engine/imported-cache.ts` and `imported-cache-types.ts`; specs/fork-rust-workflow-engine.md section 9.5).
//!
//! The cache is plain data, built from the predecessor journal by `import_build`. This module holds the
//! engine-owned consumption state (cursor, divergence, continuation) and the decisions made from it. The
//! cache itself is never written back. Every hit writes a real node row (`imported_ask_record`), so the
//! amended run is self-contained once its rows exist.
use crate::canon::canonical_json;
use crate::model::{NodeKind, NodeRow, NodeStatus, Ref};
use crate::persona::{persona_identity, persona_name};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};

/// An importable completed ask: the result of the `actorSeq`th exchange of a named actor in the predecessor.
/// The index in [`ImportedActorCandidate::entries`] is the seq.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedAskEntry {
    pub input_hash: String,
    pub result: Value,
    pub stats: Option<Value>,
    /// Node `messageBoundary` of the predecessor row. Required: the builder refuses a predecessor with a
    /// completed ask that has none.
    pub message_boundary: u64,
}

/// The ask that was in flight when the predecessor stopped (`actorSeq === entries.length`).
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedInFlightAsk {
    pub input_hash: String,
    /// Count of the predecessor's whole settled session, not an ask boundary (the in-flight ask has none).
    pub message_boundary: u64,
}

/// The importable prefix of one named actor in the predecessor.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedActorCandidate {
    /// Normalized persona of the predecessor, compared with the new actor's persona at creation.
    pub persona: Value,
    /// Completed asks, indexed by actorSeq. May be empty when `in_flight` is set.
    pub entries: Vec<ImportedAskEntry>,
    pub in_flight: Option<ImportedInFlightAsk>,
    /// Session that holds the transcript, resolved through the `resumed_from` chain.
    pub transcript_source_session_id: String,
    /// Model pin of the predecessor, applied only when a transcript is imported.
    pub resolved_model: Option<String>,
}

/// An importable world node, matched by content and by occurrence order.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedWorldEntry {
    pub input_hash: String,
    pub kind: NodeKind,
    pub result: Value,
}

/// The import cache injected into the engine. Keys: actor name (`actors`), and `inputHash({op, args})`
/// (`world`, queue order is journal insertion order).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportedRunCache {
    pub actors: BTreeMap<String, ImportedActorCandidate>,
    pub world: BTreeMap<String, Vec<ImportedWorldEntry>>,
}

/// The session seed a diverged actor's new session starts from (Node `ActorSessionSeed`).
#[derive(Debug, Clone, PartialEq)]
pub struct ActorSessionSeed {
    pub source_session_id: String,
    pub message_count: u64,
    pub resolved_model: Option<String>,
}

/// Imported consumption state of one actor: cursor, monotonic divergence, and the continuation seq.
#[derive(Debug, Clone)]
pub struct ImportedActorState {
    candidate: ImportedActorCandidate,
    /// Number of consumed entries: the next seq eligible for a hit.
    consumed: u64,
    /// Once set, the cache is never consulted again for this actor.
    diverged: bool,
    /// Seq of the predecessor's in-flight ask being continued, if any.
    carried_seq: Option<u64>,
}

impl ImportedActorState {
    pub fn new(candidate: ImportedActorCandidate) -> Self {
        Self {
            candidate,
            consumed: 0,
            diverged: false,
            carried_seq: None,
        }
    }

    /// Node `ImportedActorState.take`: a fresh ask while the cache is open. A hit advances the cursor; a
    /// miss (hash mismatch, or past the end) diverges the actor and may continue the in-flight ask.
    pub fn take(&mut self, seq: u64, hash: &str) -> Option<ImportedAskEntry> {
        if self.diverged {
            return None;
        }
        match self.entry(seq) {
            Some(entry) if entry.input_hash == hash => {
                let entry = entry.clone();
                self.consumed = seq + 1;
                Some(entry)
            }
            _ => {
                self.diverge(seq, hash, true);
                None
            }
        }
    }

    /// Node `takeIfPure`: after the cache closed, only entries with zero world tool calls may hit. Any other
    /// entry diverges the actor, and an in-flight continuation is not taken (its partial transcript saw the
    /// old workspace).
    pub fn take_if_pure(&mut self, seq: u64, hash: &str) -> Option<ImportedAskEntry> {
        if self.diverged {
            return None;
        }
        match self.entry(seq) {
            Some(entry) if entry.input_hash == hash && is_pure(entry) => {
                let entry = entry.clone();
                self.consumed = seq + 1;
                Some(entry)
            }
            _ => {
                self.diverge(seq, hash, false);
                None
            }
        }
    }

    /// Node `sourceSessionAt`: the session that holds the answer of this seq, when it was read from the
    /// predecessor transcript.
    pub fn source_session_at(&self, seq: u64) -> Option<String> {
        if !self.diverged && seq < self.consumed {
            Some(self.candidate.transcript_source_session_id.clone())
        } else {
            None
        }
    }

    /// Node `carriedAt`: whether this seq continues the predecessor's in-flight ask.
    pub fn carried_at(&self, seq: u64) -> bool {
        self.carried_seq == Some(seq)
    }

    /// Node `reconcileRecorded`: rebuild the divergence state from a recorded ask row on resume. `was_live`
    /// is the event fact "this ask ran live" (node-queued), and `queued_before_close` says whether it was
    /// admitted while the cache was still open.
    pub fn reconcile_recorded(
        &mut self,
        seq: u64,
        recorded_hash: &str,
        was_live: bool,
        queued_before_close: bool,
    ) {
        if self.diverged {
            return;
        }
        if was_live {
            self.diverge(seq, recorded_hash, queued_before_close);
            return;
        }
        match self.entry(seq) {
            Some(entry) if entry.input_hash == recorded_hash => {
                self.consumed = self.consumed.max(seq + 1);
            }
            _ => self.diverged = true,
        }
    }

    /// Node `seed`: the transcript a diverged actor's new session starts from. A continuation takes the
    /// in-flight boundary (the whole predecessor session). Otherwise the boundary of the last consumed
    /// entry, and no seed when nothing was consumed.
    pub fn seed(&self) -> Option<ActorSessionSeed> {
        if let (Some(_), Some(in_flight)) = (self.carried_seq, &self.candidate.in_flight) {
            return Some(self.seed_at(in_flight.message_boundary));
        }
        if self.consumed == 0 {
            return None;
        }
        let last = self.entry(self.consumed - 1)?;
        Some(self.seed_at(last.message_boundary))
    }

    fn entry(&self, seq: u64) -> Option<&ImportedAskEntry> {
        usize::try_from(seq)
            .ok()
            .and_then(|index| self.candidate.entries.get(index))
    }

    /// Node `diverge`: marks divergence, and records a continuation when every condition holds: the cache is
    /// open, the miss is exactly after the prefix, the whole prefix was consumed, and the hash is the
    /// in-flight ask's.
    fn diverge(&mut self, seq: u64, hash: &str, cache_open: bool) {
        if let Some(in_flight) = &self.candidate.in_flight
            && cache_open
            && seq == self.candidate.entries.len() as u64
            && self.consumed == seq
            && in_flight.input_hash == hash
        {
            self.carried_seq = Some(seq);
        }
        self.diverged = true;
    }

    fn seed_at(&self, message_count: u64) -> ActorSessionSeed {
        ActorSessionSeed {
            source_session_id: self.candidate.transcript_source_session_id.clone(),
            message_count,
            resolved_model: self.candidate.resolved_model.clone(),
        }
    }
}

/// Node `takeIfPure`'s purity test: the predecessor recorded `worldToolCalls === 0`. An entry without that
/// key counts as impure (old journals).
fn is_pure(entry: &ImportedAskEntry) -> bool {
    entry
        .stats
        .as_ref()
        .and_then(|stats| stats.get("worldToolCalls"))
        .and_then(Value::as_f64)
        == Some(0.0)
}

/// Node `ImportedWorldQueue`: one cursor per content hash. The nth occurrence maps to the nth record.
#[derive(Debug, Clone, Default)]
pub struct ImportedWorldQueue {
    world: BTreeMap<String, Vec<ImportedWorldEntry>>,
    cursors: HashMap<String, usize>,
}

impl ImportedWorldQueue {
    pub fn new(world: BTreeMap<String, Vec<ImportedWorldEntry>>) -> Self {
        Self {
            world,
            cursors: HashMap::new(),
        }
    }

    /// The next record for this hash, or `None` when it is exhausted or was never recorded (run live).
    pub fn take(&mut self, hash: &str) -> Option<ImportedWorldEntry> {
        let queue = self.world.get(hash)?;
        let cursor = self.cursors.get(hash).copied().unwrap_or(0);
        let entry = queue.get(cursor)?.clone();
        self.cursors.insert(hash.to_owned(), cursor + 1);
        Some(entry)
    }
}

/// Node `matchImportedActor`: the candidate with the actor's effective name, accepted only when the
/// normalized personas match (`model` and `budget` are not part of the identity). An anonymous actor never
/// matches.
pub fn match_imported_actor(
    cache: Option<&ImportedRunCache>,
    spec: &Value,
) -> Option<ImportedActorState> {
    let cache = cache?;
    let name = persona_name(spec).filter(|name| !name.is_empty())?;
    let candidate = cache.actors.get(name)?;
    if canonical_json(&persona_identity(spec))
        != canonical_json(&persona_identity(&candidate.persona))
    {
        return None;
    }
    Some(ImportedActorState::new(candidate.clone()))
}

/// Node `importedAskRecord`: the real row written for one ask cache hit. It carries the boundary, so this run
/// can itself be amended later (the count offset survives prefix copies).
pub fn imported_ask_record(
    run_id: &str,
    instance: &Ref,
    actor: &Ref,
    seq: u64,
    hash: &str,
    entry: &ImportedAskEntry,
) -> NodeRow {
    NodeRow {
        run_id: run_id.to_owned(),
        site_id: instance.site_id.clone(),
        ordinal: instance.ordinal,
        kind: NodeKind::Ask,
        actor_site_id: Some(actor.site_id.clone()),
        actor_ordinal: Some(actor.ordinal),
        actor_seq: Some(seq),
        input_hash: hash.to_owned(),
        status: NodeStatus::Completed,
        result: Some(entry.result.clone()),
        error: None,
        stats: entry.stats.clone(),
        input: None,
        message_boundary: Some(entry.message_boundary),
        artifact_id: None,
    }
}

impl ImportedRunCache {
    /// The cache as Node's table is written in the goldens: `actors` by name, `world` by hash. Object key
    /// order is not significant (compared canonically).
    pub fn to_json(&self) -> Value {
        let mut actors = Map::new();
        for (name, candidate) in &self.actors {
            let mut entry = Map::new();
            entry.insert("persona".into(), candidate.persona.clone());
            entry.insert(
                "entries".into(),
                Value::Array(
                    candidate
                        .entries
                        .iter()
                        .map(|ask| {
                            let mut item = Map::new();
                            item.insert("inputHash".into(), Value::String(ask.input_hash.clone()));
                            item.insert("result".into(), ask.result.clone());
                            item.insert(
                                "messageBoundary".into(),
                                Value::from(ask.message_boundary),
                            );
                            if let Some(stats) = &ask.stats {
                                item.insert("stats".into(), stats.clone());
                            }
                            Value::Object(item)
                        })
                        .collect(),
                ),
            );
            if let Some(in_flight) = &candidate.in_flight {
                entry.insert(
                    "inFlight".into(),
                    json!({"inputHash": in_flight.input_hash, "messageBoundary": in_flight.message_boundary}),
                );
            }
            entry.insert(
                "transcriptSourceSessionId".into(),
                Value::String(candidate.transcript_source_session_id.clone()),
            );
            if let Some(model) = &candidate.resolved_model {
                entry.insert("resolvedModel".into(), Value::String(model.clone()));
            }
            actors.insert(name.clone(), Value::Object(entry));
        }
        let mut world = Map::new();
        for (hash, queue) in &self.world {
            world.insert(
                hash.clone(),
                Value::Array(
                    queue
                        .iter()
                        .map(|item| {
                            json!({
                                "inputHash": item.input_hash,
                                "kind": item.kind.as_str(),
                                "result": item.result,
                            })
                        })
                        .collect(),
                ),
            );
        }
        json!({"actors": Value::Object(actors), "world": Value::Object(world)})
    }
}
