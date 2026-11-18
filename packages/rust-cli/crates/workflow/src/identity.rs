//! Node identity (`engine.ts` `nextOrdinal` and `enterPhase`, `engine-phase-stamp.ts`).
//!
//! An instance is `site × ordinal`: the ordinal is the arrival count for that site. Phase names count in
//! a separate table, so a phase named like a site cannot move the site's ordinals. Each minted instance
//! remembers its birth phase; the stamping step copies that phase onto the creation events so a later
//! reader does not need the current phase at emit time.
use crate::event::RunEvent;
use crate::model::Ref;
use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct Identity {
    ordinals: HashMap<String, u64>,
    phase_ordinals: HashMap<String, u64>,
    current_phase: Option<String>,
    site_phases: HashMap<String, String>,
    instance_phases: HashMap<String, String>,
}

impl Identity {
    /// `site_phases` is the compile-time lexical phase of each site (Node `EngineConfig.sitePhases`).
    pub fn new(site_phases: HashMap<String, String>) -> Self {
        Self {
            site_phases,
            ..Self::default()
        }
    }

    /// Node `nextOrdinal`: the next ordinal for `site_id`, and the birth phase of that instance. A
    /// lexical phase of the site wins over the current marker, as the confirmation graph shows it.
    /// Node `swapTables` in `fillHole`: later sites take their birth phase from the effective script's table.
    pub fn replace_site_phases(&mut self, site_phases: HashMap<String, String>) {
        self.site_phases = site_phases;
    }

    pub fn next_ordinal(&mut self, site_id: &str) -> u64 {
        let next = self.ordinals.get(site_id).copied().unwrap_or(0) + 1;
        self.ordinals.insert(site_id.to_owned(), next);
        let phase = self
            .site_phases
            .get(site_id)
            .or(self.current_phase.as_ref())
            .cloned();
        if let Some(phase) = phase {
            self.instance_phases
                .insert(Ref::new(site_id, next).key(), phase);
        }
        next
    }

    /// Node `enterPhase` after the trim check: counts the entry and makes the name current. Returns the
    /// entry count of this name, which is the marker's ordinal.
    pub fn enter_phase(&mut self, trimmed: &str) -> u64 {
        let ordinal = self.phase_ordinals.get(trimmed).copied().unwrap_or(0) + 1;
        self.phase_ordinals.insert(trimmed.to_owned(), ordinal);
        self.current_phase = Some(trimmed.to_owned());
        ordinal
    }

    fn phase_of(&self, key: &str) -> Option<String> {
        self.instance_phases.get(key).cloned()
    }

    /// Node `stampBirthPhase`: fills the phase fields of the creation events from the birth table.
    /// Other events are unchanged. `node-dispatched` repeats the creation facts, so it carries both the
    /// instance's phase and its actor's phase.
    pub fn stamp(&self, event: &mut RunEvent) {
        match event {
            RunEvent::ActorCreated { actor, phase, .. } => {
                *phase = self.phase_of(&actor.key());
            }
            RunEvent::NodeQueued {
                instance, phase, ..
            }
            | RunEvent::WorldQueued {
                instance, phase, ..
            } => {
                *phase = self.phase_of(&instance.key());
            }
            RunEvent::NodeDispatched {
                instance,
                actor,
                phase,
                actor_phase,
                ..
            } => {
                *phase = self.phase_of(&instance.key());
                *actor_phase = self.phase_of(&actor.key());
            }
            RunEvent::NodeSettled {
                instance,
                cached: true,
                phase,
                ..
            } => {
                *phase = self.phase_of(&instance.key());
            }
            RunEvent::HoleReached {
                instance, phase, ..
            } => {
                *phase = self.phase_of(&instance.key());
            }
            _ => {}
        }
    }
}
