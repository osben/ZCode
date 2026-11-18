//! Holes (Node `engine/engine-holes.ts`; spec 9.6): the script asks the main agent for a piece of code, and
//! the branch that reached the hole waits until the fill.
//!
//! A hole has no journal row. Its fill lands in the run row as the effective script (`update_run_script`),
//! and replay runs that script inline, so `hole-reached` does not recur on a resumed lifetime that has the
//! filled script. The engine keeps two tables for one lifetime: the parked branches by site, and the code
//! of each site filled in this lifetime (a later reach is answered from it at once).
//!
//! Promises are modelled as tickets, as for asks (`engine::AskOutcome`): a parked branch's settlement is an
//! outcome with its ticket, pushed when the fill releases it (in parked order) or when the run settles (in
//! site order, then parked order, as Node's `rejectAll`).
//!
//! Clock: Node reads `Date.now` through `EngineConfig.now`. Here the host passes the clock value with each
//! call (`hole`, `fill_hole`), so the engine reads no clock.
use crate::engine::{AskSpec, WorkflowDriver, WorkflowEngine};
use crate::error::WorkflowError;
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::Ref;
use anyhow::Result;
use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use serde_json::{Value, json};
use std::collections::HashMap;

/// `hole-reached` and the notification prompt: the cap in UTF-16 units (Node `HOLE_PROMPT_MAX_CHARS`).
pub const HOLE_PROMPT_MAX_CHARS: usize = 4000;

/// Node `boundHolePrompt`: over the cap, the prompt keeps 3,999 units and ends with `…` (one unit).
pub fn bound_hole_prompt(prompt: &str) -> String {
    if utf16_len(prompt) <= HOLE_PROMPT_MAX_CHARS {
        return prompt.to_owned();
    }
    format!("{}…", utf16_prefix(prompt, HOLE_PROMPT_MAX_CHARS - 1))
}

/// One completion (Node `HoleFill`). `code` is the hole body the effective script lowered; `script_text` and
/// `script_hash` are written to the run row together.
#[derive(Debug, Clone, PartialEq)]
pub struct HoleFill {
    pub site_id: String,
    pub code: String,
    pub script_text: String,
    pub script_hash: String,
    /// The effective script's ask spec table (a superset of the old one; the run service checks it).
    pub ask_specs: HashMap<String, AskSpec>,
    /// The effective script's site → birth phase table.
    pub site_phases: HashMap<String, String>,
    /// The effective script's phase table, holes by name.
    pub phase_names: Vec<String>,
    /// Indices of the phase names still unfilled, when the caller has them.
    pub holes: Option<Vec<u64>>,
    pub filled_by: Option<String>,
    /// The draft path this completion created, for a run that had none.
    pub script_path: Option<String>,
}

/// Node `FillHoleResult`. Both no-ops write nothing and emit nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillHoleResult {
    Filled,
    NotWaiting,
    Settled,
}

impl FillHoleResult {
    /// Node's result object: `{ ok: true }` or `{ ok: false, reason }`.
    pub fn to_json(self) -> Value {
        match self {
            Self::Filled => json!({"ok": true}),
            Self::NotWaiting => json!({"ok": false, "reason": "not_waiting"}),
            Self::Settled => json!({"ok": false, "reason": "settled"}),
        }
    }
}

/// A hole that is still waiting (Node `OpenHole`): the snapshot reads it, since no promise survives a restart.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenHole {
    pub site_id: String,
    pub ordinal: u64,
    pub name: String,
    /// Clock value at the reach.
    pub since: f64,
}

impl OpenHole {
    pub fn to_json(&self) -> Value {
        json!({"siteId": self.site_id, "ordinal": self.ordinal, "name": self.name, "since": self.since})
    }
}

/// A hole filled in this lifetime (Node `FilledHole`).
#[derive(Debug, Clone, PartialEq)]
pub struct FilledHole {
    pub site_id: String,
    pub filled_at: f64,
    pub filled_by: Option<String>,
}

impl FilledHole {
    pub fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("siteId".into(), Value::String(self.site_id.clone()));
        map.insert("filledAt".into(), crate::model::js_number(self.filled_at));
        if let Some(by) = &self.filled_by {
            map.insert("filledBy".into(), Value::String(by.clone()));
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone)]
struct ParkedHole {
    instance: Ref,
    name: String,
    since: f64,
    ticket: u64,
}

#[derive(Debug, Clone)]
struct RememberedFill {
    code: String,
    filled_at: f64,
    filled_by: Option<String>,
}

/// The hole tables of one lifetime (Node `HoleRegistry`). `order` lists the sites in the order their first
/// entry was inserted, as a JavaScript `Map` iterates them; a site leaves the order when it is released.
#[derive(Debug, Default)]
pub struct HoleRegistry {
    order: Vec<String>,
    parked: HashMap<String, Vec<ParkedHole>>,
    filled_order: Vec<String>,
    filled: HashMap<String, RememberedFill>,
}

impl HoleRegistry {
    fn remembered(&self, site: &str) -> Option<&str> {
        self.filled.get(site).map(|fill| fill.code.as_str())
    }

    fn park(&mut self, instance: Ref, name: &str, since: f64, ticket: u64) {
        let site = instance.site_id.clone();
        if !self.parked.contains_key(&site) {
            self.order.push(site.clone());
        }
        self.parked.entry(site).or_default().push(ParkedHole {
            instance,
            name: name.to_owned(),
            since,
            ticket,
        });
    }

    fn is_waiting_or_filled(&self, site: &str) -> bool {
        self.parked.get(site).is_some_and(|list| !list.is_empty()) || self.filled.contains_key(site)
    }

    /// Remember the code and release every branch parked at the site; returns their tickets in parked order.
    fn release(
        &mut self,
        site: &str,
        code: &str,
        filled_at: f64,
        filled_by: Option<&str>,
    ) -> Vec<u64> {
        let fill = RememberedFill {
            code: code.to_owned(),
            filled_at,
            filled_by: filled_by.map(str::to_owned),
        };
        if self.filled.insert(site.to_owned(), fill).is_none() {
            self.filled_order.push(site.to_owned());
        }
        self.order.retain(|key| key != site);
        self.parked
            .remove(site)
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.ticket)
            .collect()
    }

    /// Run settlement: every parked branch is rejected, in site order then parked order. Remembered fills stay.
    fn reject_all(&mut self) -> Vec<u64> {
        let order = std::mem::take(&mut self.order);
        let mut tickets = Vec::new();
        for site in order {
            if let Some(list) = self.parked.remove(&site) {
                tickets.extend(list.into_iter().map(|entry| entry.ticket));
            }
        }
        self.parked.clear();
        tickets
    }

    fn open(&self) -> Vec<OpenHole> {
        self.order
            .iter()
            .filter_map(|site| self.parked.get(site))
            .flatten()
            .map(|entry| OpenHole {
                site_id: entry.instance.site_id.clone(),
                ordinal: entry.instance.ordinal,
                name: entry.name.clone(),
                since: entry.since,
            })
            .collect()
    }

    fn filled_list(&self) -> Vec<FilledHole> {
        self.filled_order
            .iter()
            .filter_map(|site| self.filled.get(site).map(|fill| (site, fill)))
            .map(|(site, fill)| FilledHole {
                site_id: site.clone(),
                filled_at: fill.filled_at,
                filled_by: fill.filled_by.clone(),
            })
            .collect()
    }
}

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `hole` (`reachHole`): mint the ordinal, then either answer from the code this lifetime already
    /// filled (no event) or park the branch and record `hole-reached`. The branch is parked before the event
    /// is emitted, so a listener that fills the hole synchronously finds it.
    pub fn hole(
        &mut self,
        site_id: &str,
        name: &str,
        prompt: Option<&str>,
        now: f64,
    ) -> Result<u64> {
        let ticket = self.allocate_ticket();
        if self.is_settled() {
            let error = self.run_error();
            self.push_outcome(ticket, Err(error));
            return Ok(ticket);
        }
        let ordinal = self.identity.next_ordinal(site_id);
        if let Some(code) = self.holes.remembered(site_id).map(str::to_owned) {
            self.push_outcome(ticket, Ok(json!({"code": code})));
            return Ok(ticket);
        }
        let instance = Ref::new(site_id, ordinal);
        self.holes.park(instance.clone(), name, now, ticket);
        self.record(RunEvent::HoleReached {
            instance,
            name: name.to_owned(),
            prompt: prompt.map(bound_hole_prompt),
            phase: None,
        })?;
        Ok(ticket)
    }

    /// Node `fillHole`: one synchronous step. The spec and phase tables are replaced, the effective script
    /// is written to the run row, `hole-filled` is recorded, the code is remembered, and every parked branch
    /// is released. A fill for a site nobody waits on, or after settlement, changes nothing.
    pub fn fill_hole(&mut self, fill: HoleFill, now: f64) -> Result<FillHoleResult> {
        if self.is_settled() {
            return Ok(FillHoleResult::Settled);
        }
        if !self.holes.is_waiting_or_filled(&fill.site_id) {
            return Ok(FillHoleResult::NotWaiting);
        }
        let HoleFill {
            site_id,
            code,
            script_text,
            script_hash,
            ask_specs,
            site_phases,
            phase_names,
            holes,
            filled_by,
            script_path,
        } = fill;
        self.ask_specs = ask_specs;
        self.identity.replace_site_phases(site_phases);
        self.journal
            .update_run_script(&self.run_id, &script_text, &script_hash)?;
        self.record(RunEvent::HoleFilled {
            site_id: site_id.clone(),
            filled_at: now,
            filled_by: filled_by.clone(),
            phase_names,
            holes,
            script_path,
        })?;
        for ticket in self
            .holes
            .release(&site_id, &code, now, filled_by.as_deref())
        {
            self.push_outcome(ticket, Ok(json!({"code": code})));
        }
        Ok(FillHoleResult::Filled)
    }

    /// Node `openHoles`: the holes still waiting, in the order they parked by site.
    pub fn open_holes(&self) -> Vec<OpenHole> {
        self.holes.open()
    }

    /// Node `filledHoles`: the holes filled in this lifetime.
    pub fn filled_holes(&self) -> Vec<FilledHole> {
        self.holes.filled_list()
    }

    /// Node `abortInFlight`'s second half: reject every parked branch with the run error.
    pub(crate) fn reject_holes(&mut self, error: &WorkflowError) {
        for ticket in self.holes.reject_all() {
            self.push_outcome(ticket, Err(error.clone()));
        }
    }
}
