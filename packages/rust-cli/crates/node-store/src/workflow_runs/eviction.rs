//! Make room when a table is full (Node's `workflow-runs-eviction.ts`): who may leave, when an entry
//! may take a slot, and how evicted entries remain countable by birth phase.
//!
//! Pure functions over ordered JSON objects, as in Node. Table priority, highest first: running
//! (a node is dispatched, executing, waiting, repairing or nudged) > idle (queued, not started) >
//! completed (all settled). Running entries never leave; an actor never outlives its last listed
//! node; evicted entries stay countable through `caps.rs` and the phase grid.

use serde_json::Value;

use super::caps::{add_to_bucket, read_buckets, with_buckets, BucketDelta};
use super::js::{entry_ref, InstanceRef, Obj};
use super::{Limits, PRODUCTION};

/// `admitsNewEntry`: below the overflow point every event admits; an overflowed run admits new keys
/// only from live birth events.
pub fn admits_new_entry(run: &Obj, live: bool) -> bool {
    run.get("truncated") != Some(&Value::Bool(true)) || live
}

/// Node `WorkflowNodeSeating`.
pub struct Seating {
    pub run: Obj,
    pub admit_new: bool,
    pub activated: bool,
}

/// The seat being requested for one node event (`seatWorkflowNode`'s argument).
pub struct Seat<'a> {
    pub event_type: &'a str,
    pub reference: InstanceRef,
    pub actor_ref: Option<InstanceRef>,
    pub actor: Option<Obj>,
    pub born: bool,
    pub advances_water_mark: bool,
}

/// Candidate for a victim: its birth phase and whether it failed. Index is into the source list.
#[derive(Debug, Clone)]
struct Candidate {
    index: usize,
    phase_name: Option<String>,
    failed: bool,
}

/// A non-live group: an actor plus all its listed nodes, classified by what it is doing now.
#[derive(Debug, Clone)]
struct Group {
    index: usize,
    phase_name: Option<String>,
    failed: bool,
    node_indexes: Vec<usize>,
    finished: bool,
    idle: bool,
    zero_node: bool,
}

trait Pickable {
    fn phase(&self) -> Option<&str>;
    fn failed(&self) -> bool;
}

impl Pickable for Candidate {
    fn phase(&self) -> Option<&str> {
        self.phase_name.as_deref()
    }
    fn failed(&self) -> bool {
        self.failed
    }
}

impl Pickable for Group {
    fn phase(&self) -> Option<&str> {
        self.phase_name.as_deref()
    }
    fn failed(&self) -> bool {
        self.failed
    }
}

/// `pickVictim`: prefer unfailed entries, then the most crowded phase, then the earliest in table
/// order (replace only when strictly more crowded).
fn pick_victim<T: Pickable + Clone>(candidates: &[T]) -> Option<T> {
    if candidates.is_empty() {
        return None;
    }
    let unfailed: Vec<&T> = candidates.iter().filter(|c| !c.failed()).collect();
    let pool: Vec<&T> = if unfailed.is_empty() {
        candidates.iter().collect()
    } else {
        unfailed
    };
    let crowd_of = |candidate: &T| -> usize {
        let key = candidate.phase().unwrap_or("");
        pool.iter().filter(|other| other.phase().unwrap_or("") == key).count()
    };
    let mut best = pool[0];
    let mut best_crowd = crowd_of(best);
    for candidate in &pool {
        let size = crowd_of(candidate);
        if size > best_crowd {
            best = candidate;
            best_crowd = size;
        }
    }
    Some(best.clone())
}

fn list_of(run: &Obj, key: &str) -> Vec<Obj> {
    run.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
        .unwrap_or_default()
}

fn put_list(run: &mut Obj, key: &str, items: Vec<Obj>) {
    run.insert(
        key.to_string(),
        Value::Array(items.into_iter().map(Value::Object).collect()),
    );
}

fn actors_of(run: &Obj) -> Vec<Obj> {
    list_of(run, "actors")
}

fn nodes_of(run: &Obj) -> Vec<Obj> {
    list_of(run, "nodes")
}

fn phase_of(entry: &Obj) -> Option<String> {
    entry.get("phaseName").and_then(Value::as_str).map(str::to_string)
}

fn phase_str(entry: &Obj) -> Option<&str> {
    entry.get("phase").and_then(Value::as_str)
}

fn is_failed(node: &Obj) -> bool {
    matches!(node.get("outcome").and_then(Value::as_str), Some("failed") | Some("cancelled"))
}

/// A node's actor owner, when both coordinates are present.
fn owner_of(node: &Obj) -> Option<InstanceRef> {
    let site_id = node.get("actorSiteId")?.as_str()?.to_string();
    let ordinal = super::js::js_number(node.get("actorOrdinal"))?;
    Some(InstanceRef { site_id, ordinal })
}

/// Groups that are not live, in actor-table order.
fn listed_groups(run: &Obj) -> Vec<Group> {
    struct Bucket {
        nodes: Vec<usize>,
        live: bool,
        queued: bool,
        failed: bool,
    }
    let mut owned: std::collections::HashMap<String, Bucket> = std::collections::HashMap::new();
    for (index, node) in nodes_of(run).iter().enumerate() {
        let Some(owner) = owner_of(node) else { continue };
        let entry = owned.entry(owner.key()).or_insert(Bucket {
            nodes: Vec::new(),
            live: false,
            queued: false,
            failed: false,
        });
        entry.nodes.push(index);
        match phase_str(node) {
            Some("queued") => entry.queued = true,
            Some("settled") | None => {}
            Some(_) => entry.live = true,
        }
        if is_failed(node) {
            entry.failed = true;
        }
    }
    let mut groups = Vec::new();
    for (index, actor) in actors_of(run).iter().enumerate() {
        let key = entry_ref(actor).map(|r| r.key()).unwrap_or_default();
        let bucket = owned.get(&key);
        if bucket.is_some_and(|b| b.live) {
            continue;
        }
        groups.push(Group {
            index,
            phase_name: phase_of(actor),
            failed: bucket.is_some_and(|b| b.failed),
            node_indexes: bucket.map(|b| b.nodes.clone()).unwrap_or_default(),
            finished: bucket.is_some_and(|b| !b.queued),
            idle: bucket.is_some_and(|b| b.queued),
            zero_node: bucket.is_none(),
        });
    }
    groups
}

/// Unowned settled nodes (world-read, or a cached hit without an actor). Candidates for eviction.
fn loose_settled_nodes(run: &Obj) -> Vec<Candidate> {
    nodes_of(run)
        .iter()
        .enumerate()
        .filter(|(_, node)| node.get("actorSiteId").is_none() && phase_str(node) == Some("settled"))
        .map(|(index, node)| Candidate {
            index,
            phase_name: phase_of(node),
            failed: is_failed(node),
        })
        .collect()
}

/// The newcomer's own settled nodes, in table order (oldest first).
fn own_settled_nodes(run: &Obj, owner: &InstanceRef) -> Vec<Candidate> {
    nodes_of(run)
        .iter()
        .enumerate()
        .filter(|(_, node)| owner_of(node).is_some_and(|o| o.same(owner)) && phase_str(node) == Some("settled"))
        .map(|(index, node)| Candidate {
            index,
            phase_name: phase_of(node),
            failed: is_failed(node),
        })
        .collect()
}

fn owns_listed_node(run: &Obj, actor: &InstanceRef) -> bool {
    nodes_of(run).iter().any(|node| owner_of(node).is_some_and(|o| o.same(actor)))
}

fn spare_groups(run: &Obj, owner: Option<&InstanceRef>) -> Vec<Group> {
    let groups = listed_groups(run);
    let Some(owner) = owner else { return groups };
    let actors = actors_of(run);
    groups
        .into_iter()
        .filter(|group| !entry_ref(&actors[group.index]).is_some_and(|r| r.same(owner)))
        .collect()
}

/// `pickGroupVictim`: completed group, then the last idle group, then (if allowed) the last zero-node actor.
fn pick_group_victim(run: &Obj, owner: Option<&InstanceRef>, allow_zero_node: bool) -> Option<Group> {
    let groups = spare_groups(run, owner);
    let finished: Vec<Group> = groups.iter().filter(|g| g.finished).cloned().collect();
    if let Some(group) = pick_victim(&finished) {
        return Some(group);
    }
    if let Some(group) = groups.iter().rev().find(|g| g.idle) {
        return Some(group.clone());
    }
    if allow_zero_node {
        return groups.iter().rev().find(|g| g.zero_node).cloned();
    }
    None
}

/// `withUnlistedEvictions`: counts an evicted group or node in the run counters and in the phase grid.
fn with_unlisted_evictions(
    mut run: Obj,
    nodes: &[Obj],
    agent: Option<(Option<String>, bool, bool)>,
    limits: &Limits,
) -> Obj {
    let mut buckets = read_buckets(&run);
    if let Some((phase, finished, failed)) = agent {
        let delta = BucketDelta {
            actors: 1,
            actors_settled: i64::from(finished),
            actors_failed: i64::from(finished && failed),
            settled: 0,
        };
        buckets = add_to_bucket(buckets, phase.as_deref(), delta, limits.max_phases);
    }
    let mut settled_count: u64 = 0;
    for node in nodes {
        if phase_str(node) != Some("settled") {
            continue;
        }
        settled_count += 1;
        buckets = add_to_bucket(
            buckets,
            phase_of(node).as_deref(),
            BucketDelta {
                settled: 1,
                ..BucketDelta::default()
            },
            limits.max_phases,
        );
    }
    let mut usage = run
        .get("usage")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let unlisted = usage.get("nodesUnlisted").and_then(Value::as_u64).unwrap_or(0) + nodes.len() as u64;
    let settled_total = usage.get("nodesUnlistedSettled").and_then(Value::as_u64).unwrap_or(0) + settled_count;
    usage.insert("nodesUnlisted".into(), Value::from(unlisted));
    if settled_total > 0 {
        usage.insert("nodesUnlistedSettled".into(), Value::from(settled_total));
    }
    run.insert("usage".into(), Value::Object(usage));
    with_buckets(run, buckets)
}

/// `evictGroup`: removes an actor and all its listed nodes in one step.
fn evict_group(mut run: Obj, group: &Group, limits: &Limits) -> Obj {
    let actors = actors_of(&run);
    let nodes = nodes_of(&run);
    let evicted: Vec<Obj> = group.node_indexes.iter().map(|&i| nodes[i].clone()).collect();
    let agent = Some((
        actors[group.index].get("phaseName").and_then(Value::as_str).map(str::to_string),
        group.finished,
        group.finished && group.failed,
    ));
    run = with_unlisted_evictions(run, &evicted, agent, limits);
    let kept_actors: Vec<Obj> = actors
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != group.index)
        .map(|(_, a)| a)
        .collect();
    let kept_nodes: Vec<Obj> = nodes
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !group.node_indexes.contains(i))
        .map(|(_, n)| n)
        .collect();
    put_list(&mut run, "actors", kept_actors);
    put_list(&mut run, "nodes", kept_nodes);
    run.insert("truncated".into(), Value::Bool(true));
    run
}

/// `evictSingleNode`: removes one node row without touching its actor.
fn evict_single_node(mut run: Obj, candidate: &Candidate, limits: &Limits) -> Obj {
    let nodes = nodes_of(&run);
    let node = nodes[candidate.index].clone();
    run = with_unlisted_evictions(run, &[node], None, limits);
    let kept: Vec<Obj> = nodes_of(&run)
        .into_iter()
        .enumerate()
        .filter(|(i, _)| *i != candidate.index)
        .map(|(_, n)| n)
        .collect();
    put_list(&mut run, "nodes", kept);
    run.insert("truncated".into(), Value::Bool(true));
    run
}

/// `withRoomForActor`: a birth event evicts a completed group, if the actor table is full.
pub fn with_room_for_actor(run: Obj, reference: &InstanceRef, limits: &Limits) -> Obj {
    if actors_of(&run).len() < limits.max_actors {
        return run;
    }
    if actors_of(&run).iter().any(|actor| entry_ref(actor).is_some_and(|r| r.same(reference))) {
        return run;
    }
    let finished: Vec<Group> = listed_groups(&run).into_iter().filter(|g| g.finished).collect();
    match pick_victim(&finished) {
        Some(victim) => evict_group(run, &victim, limits),
        None => run,
    }
}

fn with_room_for_node(run: Obj, reference: &InstanceRef, owner: Option<&InstanceRef>, limits: &Limits) -> Obj {
    if nodes_of(&run).len() < limits.max_nodes {
        return run;
    }
    if nodes_of(&run).iter().any(|node| entry_ref(node).is_some_and(|r| r.same(reference))) {
        return run;
    }
    if let Some(loose) = pick_victim(&loose_settled_nodes(&run)) {
        return evict_single_node(run, &loose, limits);
    }
    let finished: Vec<Group> = spare_groups(&run, owner).into_iter().filter(|g| g.finished).collect();
    match pick_victim(&finished) {
        Some(victim) => evict_group(run, &victim, limits),
        None => run,
    }
}

/// `activateInstance`: a dispatch with birth facts returns an unlisted instance (and its actor)
/// to the tables. Makes room in order: actor slot, then node slot. Rejects the whole admission if
/// no slot can be made.
fn activate_instance(run: &Obj, reference: &InstanceRef, actor: &Obj, limits: &Limits) -> Seating {
    let actor_ref = entry_ref(actor).unwrap_or_else(|| reference.clone());
    let node_listed = nodes_of(run).iter().any(|node| entry_ref(node).is_some_and(|r| r.same(reference)));
    let actor_listed = actors_of(run).iter().any(|listed| entry_ref(listed).is_some_and(|r| r.same(&actor_ref)));
    if node_listed && actor_listed {
        return Seating {
            run: run.clone(),
            admit_new: true,
            activated: false,
        };
    }
    let reject = || Seating {
        run: run.clone(),
        admit_new: false,
        activated: false,
    };
    let mut next = run.clone();
    if !actor_listed && actors_of(&next).len() >= limits.max_actors {
        let Some(victim) = pick_group_victim(&next, None, true) else {
            return reject();
        };
        next = evict_group(next, &victim, limits);
    }
    if !node_listed && nodes_of(&next).len() >= limits.max_nodes {
        let own = own_settled_nodes(&next, &actor_ref).into_iter().next();
        if let Some(own) = own {
            next = evict_single_node(next, &own, limits);
        } else if let Some(loose) = pick_victim(&loose_settled_nodes(&next)) {
            next = evict_single_node(next, &loose, limits);
        } else {
            let Some(victim) = pick_group_victim(&next, Some(&actor_ref), false) else {
                return reject();
            };
            next = evict_group(next, &victim, limits);
        }
    }
    if !actor_listed {
        // The subagent returns to the table: it is no longer unlisted.
        let mut with_actor = next.clone();
        let mut list = actors_of(&with_actor);
        list.push(actor.clone());
        put_list(&mut with_actor, "actors", list);
        let buckets = add_to_bucket(
            read_buckets(&next),
            phase_of(actor).as_deref(),
            BucketDelta {
                actors: -1,
                ..BucketDelta::default()
            },
            limits.max_phases,
        );
        next = with_buckets(with_actor, buckets);
    }
    Seating {
        run: next,
        admit_new: true,
        activated: !node_listed,
    }
}

/// `seatWorkflowNode`: the only entry point for eviction, rejection and activation for a node event.
pub fn seat_workflow_node(run: &Obj, seat: &Seat<'_>, limits: &Limits) -> Seating {
    let by_birth = admits_new_entry(run, seat.born && seat.advances_water_mark);
    if !seat.advances_water_mark {
        return Seating {
            run: run.clone(),
            admit_new: by_birth,
            activated: false,
        };
    }
    let overflowed = run.get("truncated") == Some(&Value::Bool(true));
    if seat.event_type == "node-dispatched" && overflowed {
        if let Some(actor) = &seat.actor {
            return activate_instance(run, &seat.reference, actor, limits);
        }
    }
    if seat.born && overflowed {
        if let Some(actor_ref) = &seat.actor_ref {
            if !actors_of(run).iter().any(|actor| entry_ref(actor).is_some_and(|r| r.same(actor_ref))) {
                return Seating {
                    run: run.clone(),
                    admit_new: false,
                    activated: false,
                };
            }
        }
    }
    if seat.event_type != "node-queued" {
        return Seating {
            run: run.clone(),
            admit_new: by_birth,
            activated: false,
        };
    }
    Seating {
        run: with_room_for_node(run.clone(), &seat.reference, seat.actor_ref.as_ref(), limits),
        admit_new: by_birth,
        activated: false,
    }
}

/// `absorbRefusedActor`: a rejected `actor-created` is counted only in its birth-phase bucket.
pub fn absorb_refused_actor(run: Obj, phase_name: Option<&str>, limits: &Limits) -> Obj {
    let buckets = add_to_bucket(
        read_buckets(&run),
        phase_name,
        BucketDelta {
            actors: 1,
            ..BucketDelta::default()
        },
        limits.max_phases,
    );
    with_buckets(run, buckets)
}

/// `absorbRefusedSettledNode`: a node settled at birth and refused. Counted in its bucket; its actor
/// leaves too if it has no other listed node (the orphan rule).
pub fn absorb_refused_settled_node(run: Obj, node: &Obj, limits: &Limits) -> Obj {
    let mut buckets = add_to_bucket(
        read_buckets(&run),
        phase_of(node).as_deref(),
        BucketDelta {
            settled: 1,
            ..BucketDelta::default()
        },
        limits.max_phases,
    );
    let owner = owner_of(node);
    let actors = actors_of(&run);
    let index = owner
        .as_ref()
        .and_then(|o| actors.iter().position(|actor| entry_ref(actor).is_some_and(|r| r.same(o))));
    let orphan = match index {
        Some(i) => {
            let actor_ref = entry_ref(&actors[i]);
            actor_ref.as_ref().is_some_and(|r| !owns_listed_node(&run, r))
        }
        None => false,
    };
    let mut next = run;
    if orphan {
        let i = index.unwrap_or(0);
        buckets = add_to_bucket(
            buckets,
            phase_of(&actors[i]).as_deref(),
            BucketDelta {
                actors: 1,
                actors_settled: 1,
                actors_failed: i64::from(is_failed(node)),
                settled: 0,
            },
            limits.max_phases,
        );
        let mut list = actors;
        list.remove(i);
        put_list(&mut next, "actors", list);
    }
    with_buckets(next, buckets)
}

/// Applied to the run list when the entry budget is exceeded: evict the oldest terminal run until
/// within budget. Active runs and the run receiving the event are never evicted.
pub fn evict_for_entry_budget(runs: Vec<Obj>, event_run_id: &str, _limits: &Limits) -> Vec<Obj> {
    let size = |run: &Obj| nodes_of(run).len() + actors_of(run).len();
    let mut total: usize = runs.iter().map(size).sum();
    if total <= PRODUCTION.max_total_entries {
        return runs;
    }
    let mut remaining = runs;
    while total > PRODUCTION.max_total_entries {
        let index = remaining.iter().position(|run| {
            let id = run.get("runId").and_then(Value::as_str);
            let status = run.get("status").and_then(Value::as_str);
            id != Some(event_run_id) && status != Some("pending") && status != Some("running")
        });
        let Some(index) = index else { break };
        total -= size(&remaining[index]);
        remaining.remove(index);
    }
    remaining
}
