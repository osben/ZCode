//! Fork: subagent rows and the snapshot `subagents` manifest (Node `product-projection.ts`
//! `onSubagentSpawned` / `onSubagentStopped` / `materializeSubagentProjection`;
//! specs/fork-rust-agent-parity.md).
//!
//! zcode-rs has no SubagentSpawned / SubagentStopped events. The facts come from what the
//! adapter already sees:
//! - the child's first progress on the Agent call (`ToolProgress.data.agentId`) is the spawn;
//! - the Agent call's result display (`display.agent`: agentId, childSessionId, agentType,
//!   status) settles a foreground child, or marks a background launch (`async_launched`);
//! - the kernel's live subagent table (`SessionHandle::subagents`, fed through
//!   [`Projection::subagent_table`]) settles background children and reports waiting.
//!
//! The manifest is derived from the rows only, so a row is the single owner of a child's state.

use std::collections::{HashMap, HashSet};

use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use serde_json::{Map, Value, json};

use super::kinds::RowKind;
use super::{Projection, tool_key};

/// The tools whose calls spawn a subagent (Node `SUBAGENT_TOOL_NAMES`).
const SUBAGENT_TOOLS: [&str; 3] = ["Agent", "Task", "subagent"];

/// The default agent type of an Agent call without `subagent_type`.
const GENERAL_PURPOSE: &str = "general-purpose";

/// A row field, `Null` when absent (indexing a `Map` panics on a missing key).
fn field<'a>(row: &'a Map<String, Value>, key: &str) -> &'a Value {
    row.get(key).unwrap_or(&Value::Null)
}

fn subagent_key(agent: &str) -> String {
    format!("subagent:{agent}")
}

/// The child session of an agent: the id the runtime spawns it with (`sess_subagent_<agentId>`,
/// node-store `NodeIds::subagent`, Node's `createSessionId("subagent_<agentId>")`).
fn child_session(agent: &str) -> String {
    format!("sess_subagent_{agent}")
}

/// The snapshot `subagents` (`subagentProjectionStateSchema`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Manifest {
    revision: u64,
    child_session_ids: Vec<String>,
    running: Vec<Value>,
    ended_total: usize,
}

impl Manifest {
    pub(super) fn to_value(&self) -> Value {
        json!({
            "revision": self.revision,
            "childSessionIds": self.child_session_ids,
            "running": self.running,
            "endedTotal": self.ended_total,
        })
    }
}

/// What the projection remembers about subagents besides the rows.
#[derive(Debug, Clone, Default)]
pub(super) struct Subagents {
    /// Agents that have a row (the row key is [`subagent_key`]).
    known: HashSet<String>,
    /// Children with an interaction waiting on the user (live table `waiting`).
    waiting: HashSet<String>,
    /// How each ended agent ended (live table), for a background launch whose result arrives after its child
    /// already ended.
    ended: HashMap<String, &'static str>,
    pub(super) manifest: Manifest,
    /// The snapshot `backgroundWorks`: the running background children of the live table (Node
    /// `onBackgroundTaskLifecycle` / `resumedSubagentBackgroundWorkDelta` for `kind: "subagent"`). An ended
    /// child leaves the list; the UI reads only running works.
    pub(super) works: Vec<Value>,
    /// Fork (B2, Node `liveSubagentStopControlByChildId`): child session → `{taskId, executionId}` of the run the
    /// desktop's Stop ends. Rebuilt from each live table, never from rows, so a cold open has none and a new run
    /// replaces the old one.
    stop_controls: HashMap<String, Value>,
}

impl Projection {
    /// Fork: the subagent rows as the telemetry facts read them (crate::telemetry), in row order.
    pub(crate) fn subagent_links(&self) -> Vec<crate::telemetry::SubagentLink> {
        let text = |row: &Map<String, Value>, key: &str| {
            field(row, key)
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let mut agents: Vec<(&String, usize)> = self
            .subagents
            .known
            .iter()
            .filter_map(|agent| Some((agent, *self.index.get(&subagent_key(agent))?)))
            .collect();
        agents.sort_by_key(|(_, at)| *at);
        agents
            .into_iter()
            .map(|(agent, at)| {
                let row = &self.rows[at];
                let parent_tool = text(row, "parentToolCallId").unwrap_or_default();
                // A background launch is known from the call's input before its result marks the row.
                let launched_in_background =
                    self.index
                        .get(&tool_key(&parent_tool))
                        .is_some_and(|&call| {
                            field(&self.rows[call], "input")["run_in_background"] == true
                        });
                crate::telemetry::SubagentLink {
                    agent: agent.clone(),
                    agent_type: text(row, "subagentType"),
                    child: text(row, "childSessionId").unwrap_or_else(|| child_session(agent)),
                    parent_tool,
                    background: launched_in_background
                        || field(row, "backgrounded") == &Value::Bool(true),
                    status: text(row, "status").unwrap_or_default(),
                    turn: text(row, "turnId"),
                }
            })
            .collect()
    }

    fn is_subagent_call(&self, tool_use: &str) -> bool {
        self.index.get(&tool_key(tool_use)).is_some_and(|&at| {
            field(&self.rows[at], "toolName")
                .as_str()
                .is_some_and(|name| SUBAGENT_TOOLS.contains(&name))
        })
    }

    /// The spawn: a new row anchored to the Agent call (Node `onSubagentSpawned`).
    fn spawn_subagent(
        &mut self,
        tool_use: &str,
        agent: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        if !self.subagents.known.insert(agent.to_owned()) {
            return;
        }
        let Some(&at) = self.index.get(&tool_key(tool_use)) else {
            return;
        };
        let call = &self.rows[at];
        let turn = field(call, "turnId")
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let input = field(call, "input").clone();
        let text = |key: &str| {
            input[key]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        let mut row = self.base(&turn, agent, RowKind::Subagent, now, seq);
        row.insert("parentToolCallId".into(), json!(tool_use));
        row.insert(
            "subagentType".into(),
            json!(text("subagent_type").unwrap_or_else(|| GENERAL_PURPOSE.to_owned())),
        );
        row.insert("status".into(), json!("running"));
        row.insert(
            "summaryText".into(),
            json!(
                text("description")
                    .or_else(|| text("prompt"))
                    .unwrap_or_default()
            ),
        );
        row.insert("childSessionId".into(), json!(child_session(agent)));
        row.insert("startedAt".into(), json!(now));
        self.append(subagent_key(agent), row, out);
    }

    /// A child's progress on its Agent call: the first one is the spawn.
    pub(super) fn subagent_progress(
        &mut self,
        tool_use: &str,
        data: &Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let Some(agent) = data["agentId"].as_str().filter(|id| !id.is_empty()) else {
            return;
        };
        if self.is_subagent_call(tool_use) {
            self.spawn_subagent(tool_use, agent, now, seq, out);
        }
    }

    /// The Agent call's result (Node `onSubagentStopped` for a foreground child; a background
    /// launch keeps the row running, `backgrounded`, until the live table settles it).
    pub(super) fn subagent_result(
        &mut self,
        tool_use: &str,
        display: &Value,
        status: &str,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let link = &display[rust_cli_kernel_api::agents::DISPLAY_KEY];
        let Some(agent) = link["agentId"].as_str().filter(|id| !id.is_empty()) else {
            return;
        };
        if !self.is_subagent_call(tool_use) {
            return;
        }
        self.spawn_subagent(tool_use, agent, now, seq, out);
        let child = link["childSessionId"].as_str().filter(|id| !id.is_empty());
        let agent_type = link["agentType"].as_str().filter(|kind| !kind.is_empty());
        let launched = link["status"] == "async_launched";
        let ended = self.subagents.ended.get(agent).copied();
        self.upsert(
            &subagent_key(agent),
            |row| {
                if let Some(child) = child {
                    row.insert("childSessionId".into(), json!(child));
                }
                if let Some(agent_type) = agent_type {
                    row.insert("subagentType".into(), json!(agent_type));
                }
                let settled = if launched {
                    row.insert("backgrounded".into(), json!(true));
                    row.insert("workId".into(), json!(agent));
                    ended
                } else {
                    Some(status)
                };
                if let Some(settled) = settled
                    && field(row, "status") == "running"
                {
                    row.insert("status".into(), json!(settled));
                    row.insert("endedAt".into(), json!(now));
                }
            },
            out,
        );
    }

    /// A turn that ends stops its foreground children with it.
    pub(super) fn settle_open_subagent(row: &mut Map<String, Value>, now: u64) {
        if field(row, "status") == "running" && row.get("backgrounded").is_none() {
            row.insert("status".into(), json!("cancelled"));
            row.insert("endedAt".into(), json!(now));
        }
    }

    /// Fork: the kernel's live subagent table changed: settle background children that ended and
    /// track which children wait on the user. Returns the deltas, manifest patch included.
    pub fn subagent_table(&mut self, entries: &[SubagentEntry], now: u64) -> Vec<Value> {
        let mut out = Vec::new();
        for entry in entries {
            if entry.status == SubagentStatus::Running && entry.background {
                self.reopen_subagent(entry, now, &mut out);
            }
        }
        self.subagents.waiting = entries
            .iter()
            .filter(|entry| entry.status == SubagentStatus::Running && entry.waiting)
            .map(|entry| entry.child.as_str().to_owned())
            .collect();
        for entry in entries {
            let status = match entry.status {
                SubagentStatus::Running => continue,
                SubagentStatus::Completed => "success",
                SubagentStatus::Failed => "failed",
                // A killed subagent was aborted by the user — Node's `cancelled`.
                SubagentStatus::Killed => "cancelled",
            };
            // A parked agent finished its own work but keeps running background children.
            if entry.parked {
                continue;
            }
            self.subagents
                .ended
                .insert(entry.agent.as_str().to_owned(), status);
            self.upsert(
                &subagent_key(entry.agent.as_str()),
                |row| {
                    if field(row, "status") == "running" {
                        row.insert("status".into(), json!(status));
                        row.insert("endedAt".into(), json!(now));
                    }
                },
                &mut out,
            );
        }
        // A child this session spawned itself (no owning subagent) that runs or is parked.
        self.subagents.stop_controls = entries
            .iter()
            .filter(|entry| {
                entry.owner.is_none() && (entry.status == SubagentStatus::Running || entry.parked)
            })
            .map(|entry| {
                (
                    entry.child.as_str().to_owned(),
                    json!({"taskId": entry.agent.as_str(), "executionId": entry.execution.to_string()}),
                )
            })
            .collect();
        let mut patch = Map::new();
        if let Some(manifest) = self.materialize_subagents() {
            patch.insert("subagents".into(), manifest);
        }
        if self.background_works(entries, now) {
            patch.insert("backgroundWorks".into(), self.background_works_value());
        }
        if !patch.is_empty() {
            out.push(json!({"op": "state.updated", "patch": patch}));
        }
        out
    }

    /// A finished child that runs again in the background (SendMessage resume, a parked agent's wake): its
    /// row runs again, `backgrounded` (Node `onSubagentSpawned` on an existing row; the anchor stays).
    fn reopen_subagent(&mut self, entry: &SubagentEntry, now: u64, out: &mut Vec<Value>) {
        let agent = entry.agent.as_str();
        if !self.subagents.known.contains(agent) {
            return;
        }
        self.subagents.ended.remove(agent);
        let description = entry.description.trim();
        self.upsert(
            &subagent_key(agent),
            |row| {
                if field(row, "status") == "running" {
                    return;
                }
                row.insert("status".into(), json!("running"));
                row.insert("backgrounded".into(), json!(true));
                row.insert("workId".into(), json!(agent));
                row.insert("childSessionId".into(), json!(entry.child.as_str()));
                if !description.is_empty() {
                    row.insert("summaryText".into(), json!(description));
                }
                row.insert("startedAt".into(), json!(now));
                row.remove("endedAt");
            },
            out,
        );
    }

    /// The running background children as `backgroundWorks` items; false when the list did not change.
    fn background_works(&mut self, entries: &[SubagentEntry], now: u64) -> bool {
        let previous = &self.subagents.works;
        let works: Vec<Value> = entries
            .iter()
            .filter(|entry| entry.status == SubagentStatus::Running && entry.background)
            .map(|entry| {
                let agent = entry.agent.as_str();
                let existing = previous.iter().find(|work| work["workId"] == agent);
                let description = entry.description.trim();
                json!({
                    "workId": agent,
                    "kind": "subagent",
                    "title": if description.is_empty() { agent } else { description },
                    "status": "running",
                    "startedAt": existing
                        .and_then(|work| work["startedAt"].as_u64())
                        .unwrap_or(now),
                    "cancellable": true,
                    "blocked": entry.waiting,
                    "anchorRowId": Value::Null,
                    "childSessionId": entry.child.as_str(),
                })
            })
            .collect();
        if works == *previous {
            return false;
        }
        self.subagents.works = works;
        true
    }

    /// Node `materializeSubagentProjection`: the manifest from the subagent rows, published only
    /// when its meaning changes (the revision counts those changes).
    pub(super) fn materialize_subagents(&mut self) -> Option<Value> {
        let previous = &self.subagents.manifest;
        let mut child_session_ids: Vec<String> = Vec::new();
        let mut running = Vec::new();
        for row in &self.rows {
            if RowKind::of(row) != Some(RowKind::Subagent) {
                continue;
            }
            let Some(child) = field(row, "childSessionId").as_str() else {
                continue;
            };
            if child_session_ids.iter().any(|id| id == child) {
                continue;
            }
            child_session_ids.push(child.to_owned());
            if field(row, "status") != "running" {
                continue;
            }
            let previous_title = previous
                .running
                .iter()
                .find(|item| item["childSessionId"] == child)
                .and_then(|item| item["title"].as_str())
                .filter(|title| !title.is_empty());
            let summary = field(row, "summaryText")
                .as_str()
                .unwrap_or_default()
                .trim();
            let subagent_type = field(row, "subagentType").as_str().unwrap_or_default();
            let title = previous_title
                .or(Some(summary).filter(|summary| !summary.is_empty()))
                .unwrap_or(subagent_type);
            let status = if self.subagents.waiting.contains(child) {
                if row.get("backgrounded").is_some() {
                    "blocked"
                } else {
                    "waiting"
                }
            } else {
                "running"
            };
            let mut item = json!({
                "childSessionId": child,
                "agentId": field(row, "entityId"),
                "subagentType": subagent_type,
                "title": title,
                "status": status,
            });
            if let Some(control) = self.subagents.stop_controls.get(child) {
                item["stopControl"] = control.clone();
            }
            if let Some(call) = field(row, "parentToolCallId").as_str() {
                item["toolCallId"] = json!(call);
            }
            if let Some(started) = field(row, "startedAt").as_u64() {
                item["startedAt"] = json!(started);
            }
            running.push(item);
        }
        running.sort_by(|left, right| {
            let started = |item: &Value| item["startedAt"].as_u64().unwrap_or(0);
            started(right).cmp(&started(left)).then_with(|| {
                right["childSessionId"]
                    .as_str()
                    .cmp(&left["childSessionId"].as_str())
            })
        });
        let ended_total = child_session_ids.len() - running.len();
        if child_session_ids == previous.child_session_ids
            && running == previous.running
            && ended_total == previous.ended_total
        {
            return None;
        }
        self.subagents.manifest = Manifest {
            revision: previous.revision + 1,
            child_session_ids,
            running,
            ended_total,
        };
        Some(self.subagents.manifest.to_value())
    }
}
