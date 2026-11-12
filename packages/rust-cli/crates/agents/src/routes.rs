//! Fork: the registry of subagent child sessions whose background-command notices have a forwarder
//! (specs/fork-rust-agent-parity.md, "After a restart, and on a remote executor").
//!
//! It lives inside `live::Live`, under the same lock as the agents, so one critical section decides whether a
//! child's notice can be taken (`want`), pushes it to the owner or the top-level session's Hub, and changes the
//! registry. An entry is removed only by its own forwarder task, under that lock: while an entry exists, no second
//! forwarder for the child can start. Lock order: Live, then Hub.

use std::collections::HashMap;

use rust_cli_kernel_api::ids::SessionId;
use tokio::sync::watch;

use crate::live::Agents;

#[derive(Default)]
pub(crate) struct Routes {
    /// Open top-level sessions and the generation of their latest open.
    open: HashMap<SessionId, u64>,
    /// Bumped by each erase: an adoption that read the store before it reads again.
    erase_epoch: u64,
    children: HashMap<SessionId, Route>,
    next: u64,
}

struct Route {
    root: SessionId,
    /// Tells this entry's task from any other.
    id: u64,
    /// `want` at the last reconcile; the task leaves at its next safe point once this is false.
    active: bool,
    erased: bool,
    /// Wakes the task when the entry turns inactive.
    wake: watch::Sender<()>,
}

/// A started entry: its id and the wake its task waits on.
pub(crate) struct Started {
    pub(crate) id: u64,
    pub(crate) wake: watch::Receiver<()>,
}

/// An adoption's claims, checked against the open it started from.
pub(crate) enum Adopted {
    /// The top-level session closed or reopened since: nothing was claimed.
    Closed,
    /// An erase happened since the store read: read again with this epoch.
    Retry(u64),
    Claimed(Vec<(SessionId, Started)>),
}

impl Routes {
    fn next(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    /// The top-level session `root` opened: its generation and the current erase epoch, for its adoption.
    pub(crate) fn opened(&mut self, root: &SessionId) -> (u64, u64) {
        let generation = self.next();
        self.open.insert(root.clone(), generation);
        (generation, self.erase_epoch)
    }

    /// `root` started closing (before its actor exits).
    pub(crate) fn closing(&mut self, root: &SessionId) {
        self.open.remove(root);
    }

    /// `sessions` were erased: none is open, every entry of an erased child or root is unwanted, and adoptions in
    /// flight read the store again.
    pub(crate) fn erased(&mut self, sessions: &[SessionId]) {
        self.erase_epoch += 1;
        for session in sessions {
            self.open.remove(session);
        }
        for (child, route) in &mut self.children {
            if sessions.contains(child) || sessions.contains(&route.root) {
                route.erased = true;
            }
        }
    }

    /// Whether a notice of `child` can be taken now: it is not erased, and its top-level session is open or a live
    /// (running or parked) agent owns it.
    pub(crate) fn want(&self, agents: &Agents, child: &SessionId) -> bool {
        self.children.get(child).is_some_and(|route| {
            !route.erased
                && (self.open.contains_key(&route.root)
                    || agents
                        .values()
                        .any(|agent| &agent.child == child && agent.is_live()))
        })
    }

    /// After every change under the lock: an entry that is no longer wanted wakes its task; one wanted again
    /// (a reopen while its task finishes an ack) stays with that task.
    pub(crate) fn reconcile(&mut self, agents: &Agents) {
        let wanted: Vec<(SessionId, bool)> = self
            .children
            .keys()
            .map(|child| (child.clone(), self.want(agents, child)))
            .collect();
        for (child, want) in wanted {
            if let Some(route) = self.children.get_mut(&child)
                && route.active != want
            {
                route.active = want;
                if !want {
                    route.wake.send_replace(());
                }
            }
        }
    }

    /// Registers `child` (top-level session `root`) unless it has an entry; the caller starts the task.
    pub(crate) fn claim(&mut self, child: &SessionId, root: &SessionId) -> Option<Started> {
        if self.children.contains_key(child) {
            return None;
        }
        let id = self.next();
        let (wake, receiver) = watch::channel(());
        self.children.insert(
            child.clone(),
            Route {
                root: root.clone(),
                id,
                active: true,
                erased: false,
                wake,
            },
        );
        Some(Started { id, wake: receiver })
    }

    /// An adoption's claims for `root`, valid only while `root` is still open at `generation` and no erase happened
    /// since `epoch`.
    pub(crate) fn adopt(
        &mut self,
        root: &SessionId,
        (generation, epoch): (u64, u64),
        children: &[SessionId],
    ) -> Adopted {
        if self.open.get(root) != Some(&generation) {
            return Adopted::Closed;
        }
        if self.erase_epoch != epoch {
            return Adopted::Retry(self.erase_epoch);
        }
        Adopted::Claimed(
            children
                .iter()
                .filter_map(|child| {
                    self.claim(child, root)
                        .map(|started| (child.clone(), started))
                })
                .collect(),
        )
    }

    /// The task `id` of `child` leaves when its entry is no longer wanted: the entry goes in the same section.
    pub(crate) fn leave_if_unwanted(&mut self, child: &SessionId, id: u64) -> bool {
        match self.children.get(child) {
            Some(route) if route.id == id => {
                if route.active {
                    return false;
                }
                self.children.remove(child);
                true
            }
            // Not its entry (cannot happen: only the task removes it).
            _ => true,
        }
    }

    /// The task `id` of `child` ends (its notice stream ended, or it refused a notice): its entry goes.
    pub(crate) fn remove(&mut self, child: &SessionId, id: u64) {
        if self.children.get(child).is_some_and(|route| route.id == id) {
            self.children.remove(child);
        }
    }
}

#[cfg(test)]
#[path = "routes_tests.rs"]
mod tests;
