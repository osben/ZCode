//! Fork: the MCP App lease registry of a Rust-run server (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted
//! servers (F7)", PR 1). Port of Node `zcode-protocol/mcp-ui/instances.ts`.
//!
//! Owner: [`Instances`] is the only owner of the panel tokens of Rust-run servers. A lease is bound to the connection
//! it was opened on, a [`Connection`] of (identity, generation). Each guarded call validates the lease against the
//! connection it names, and a generation bump of that server revokes its leases (in-flight calls are cancelled first,
//! then the lease is removed).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rust_cli_base::random;
use rust_cli_base::sync::LockUnpoisoned;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/// The connection a lease is bound to: `identity` is a hash of the server's launch identity, `generation` counts the
/// server's published clients (Node `appConnectionSnapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Connection {
    pub identity: String,
    pub generation: u64,
}

/// The binding of a panel instance (Node `McpUiInstanceBinding`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Binding {
    pub workspace: String,
    pub account_context: Option<String>,
    pub session_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub scope_id: String,
    pub resource_uri: String,
    pub owner_web_contents_id: u64,
}

/// The lease the panel holds (Node `McpAppInstance`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Lease {
    pub runtime_id: String,
    pub generation: u64,
    pub token: String,
    pub app_identity: String,
}

/// The scope a request names (Node `McpUiPluginScope` plus the instance).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Scope<'a> {
    pub workspace: &'a str,
    pub session_id: &'a str,
    pub plugin_id: &'a str,
    pub server_name: &'a str,
}

/// A validated lease: its cancel signal (fires on revoke or close) and the resource it is bound to.
#[derive(Debug, Clone)]
pub(crate) struct Active {
    pub cancel: CancellationToken,
    pub resource_uri: String,
}

/// Node's `new Error("MCP App instance is no longer authorized")`.
pub(crate) const UNAUTHORIZED: &str = "MCP App instance is no longer authorized";

/// A refused [`Instances::validate_closing`]: the message, and the lease the refusal closed (a source mismatch).
#[derive(Debug)]
pub(crate) struct Refused {
    pub message: String,
    pub closed: Option<Lease>,
}

impl Refused {
    fn unauthorized(closed: Option<Lease>) -> Self {
        Self {
            message: UNAUTHORIZED.to_owned(),
            closed,
        }
    }
}

/// One live lease: its binding, the connection it is bound to, its in-flight calls (`pins`) and the cancel signal.
struct Record {
    lease: Lease,
    binding: Binding,
    source: Connection,
    cancel: CancellationToken,
    pins: BTreeSet<String>,
}

#[derive(Default)]
struct State {
    /// token -> record. Node's `records`.
    records: BTreeMap<String, Record>,
    /// The logical key of a binding -> its current token. Node's `logical`.
    logical: BTreeMap<String, String>,
}

/// The owner of the panel tokens of Rust-run servers (Node `McpUiInstances`).
pub(crate) struct Instances {
    runtime_id: String,
    generation: AtomicU64,
    state: Mutex<State>,
}

fn random_hex() -> String {
    format!("{:016x}{:016x}", random::u64(), random::u64())
}

/// Node `key`: the binding fields that name a logical panel (the connection is not part of it).
fn logical_key(binding: &Binding) -> String {
    serde_json::json!([
        binding.workspace,
        binding.session_id,
        binding.plugin_id,
        binding.server_name,
        binding.scope_id,
        binding.resource_uri,
        binding.owner_web_contents_id,
    ])
    .to_string()
}

/// Node `appIdentity`: a hash of the workspace, the server, the connection identity and the account context.
fn app_identity(binding: &Binding, source: &Connection) -> String {
    let digest = Sha256::digest(
        serde_json::json!([
            binding.workspace,
            binding.server_name,
            source.identity,
            binding.account_context.clone().unwrap_or_default(),
        ])
        .to_string(),
    );
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Fires the lease's cancel, then removes it: an in-flight call sees the revoke before its result can land.
fn cancel_and_remove(state: &mut State, token: &str) -> Option<Lease> {
    let record = state.records.remove(token)?;
    record.cancel.cancel();
    let key = logical_key(&record.binding);
    if state
        .logical
        .get(&key)
        .is_some_and(|current| current == token)
    {
        state.logical.remove(&key);
    }
    Some(record.lease)
}

impl Instances {
    pub(crate) fn new(runtime_id: &str) -> Self {
        Self {
            runtime_id: runtime_id.to_owned(),
            generation: AtomicU64::new(0),
            state: Mutex::new(State::default()),
        }
    }

    /// Node `open`: a lease for the same binding on the same connection is reused, another one is closed first.
    pub(crate) fn open(&self, binding: Binding, source: &Connection) -> Lease {
        let key = logical_key(&binding);
        let mut state = self.state.lock_unpoisoned();
        let reusable = state
            .logical
            .get(&key)
            .and_then(|token| state.records.get(token))
            .filter(|record| {
                record.source == *source
                    && record.binding.account_context == binding.account_context
            })
            .map(|record| record.lease.clone());
        if let Some(lease) = reusable {
            return lease;
        }
        if let Some(token) = state.logical.remove(&key) {
            cancel_and_remove(&mut state, &token);
        }
        let lease = Lease {
            runtime_id: self.runtime_id.clone(),
            generation: self.generation.fetch_add(1, Ordering::Relaxed) + 1,
            token: random_hex(),
            app_identity: app_identity(&binding, source),
        };
        state.records.insert(
            lease.token.clone(),
            Record {
                lease: lease.clone(),
                binding,
                source: source.clone(),
                cancel: CancellationToken::new(),
                pins: BTreeSet::new(),
            },
        );
        state.logical.insert(key, lease.token.clone());
        lease
    }

    /// Node `validate`: the lease and the scope must match. A request that names another connection closes the
    /// lease; a scope mismatch only refuses the request, so one server's bad request cannot close another's panel.
    pub(crate) fn validate(
        &self,
        lease: &Lease,
        scope: Scope<'_>,
        source: Option<&Connection>,
    ) -> Result<Active, String> {
        self.validate_closing(lease, scope, source)
            .map_err(|refused| refused.message)
    }

    /// [`Instances::validate`] with the lease a refusal closed. The owner sends the closed notice of that lease (Node's
    /// abort listener runs on every close, the one of a source mismatch included).
    pub(crate) fn validate_closing(
        &self,
        lease: &Lease,
        scope: Scope<'_>,
        source: Option<&Connection>,
    ) -> Result<Active, Refused> {
        let mut state = self.state.lock_unpoisoned();
        let in_scope = state.records.get(&lease.token).is_some_and(|record| {
            record.lease.runtime_id == lease.runtime_id
                && record.lease.generation == lease.generation
                && record.lease.app_identity == lease.app_identity
                && record.binding.workspace == scope.workspace
                && record.binding.session_id == scope.session_id
                && record.binding.plugin_id == scope.plugin_id
                && record.binding.server_name == scope.server_name
        });
        if !in_scope {
            return Err(Refused::unauthorized(None));
        }
        let record = &state.records[&lease.token];
        if source != Some(&record.source) {
            let closed = cancel_and_remove(&mut state, &lease.token);
            return Err(Refused::unauthorized(closed));
        }
        let record = &state.records[&lease.token];
        Ok(Active {
            cancel: record.cancel.clone(),
            resource_uri: record.binding.resource_uri.clone(),
        })
    }

    /// Node `retain`: a pin for one in-flight call. The returned key releases it.
    pub(crate) fn retain(&self, token: &str, call_id: &str) -> Result<String, String> {
        let mut state = self.state.lock_unpoisoned();
        let record = state
            .records
            .get_mut(token)
            .ok_or_else(|| UNAUTHORIZED.to_owned())?;
        let pin = format!("{call_id}:{}", random_hex());
        record.pins.insert(pin.clone());
        Ok(pin)
    }

    pub(crate) fn release(&self, token: &str, pin: &str) {
        if let Some(record) = self.state.lock_unpoisoned().records.get_mut(token) {
            record.pins.remove(pin);
        }
    }

    pub(crate) fn is_busy(&self, lease: &Lease) -> bool {
        self.state
            .lock_unpoisoned()
            .records
            .get(&lease.token)
            .is_some_and(|record| !record.pins.is_empty())
    }

    /// Node `close`: removes the lease and cancels its calls. `false` when the lease is not current.
    pub(crate) fn close(&self, lease: &Lease) -> bool {
        let mut state = self.state.lock_unpoisoned();
        let current = state.records.get(&lease.token).is_some_and(|record| {
            record.lease.runtime_id == lease.runtime_id
                && record.lease.generation == lease.generation
                && record.lease.app_identity == lease.app_identity
        });
        if !current {
            return false;
        }
        cancel_and_remove(&mut state, &lease.token);
        true
    }

    /// Node `closeSession`: closes every lease of `session_id`, and returns them.
    pub(crate) fn close_session(&self, session_id: &str) -> Vec<Lease> {
        self.close_where(|record| record.binding.session_id == session_id)
    }

    /// The generation bump of `server_name` in `session_id`: cancels and closes its leases, and returns them.
    pub(crate) fn revoke_server(&self, session_id: &str, server_name: &str) -> Vec<Lease> {
        self.close_where(|record| {
            record.binding.session_id == session_id && record.binding.server_name == server_name
        })
    }

    /// The connection a live lease is bound to (Node `find(token).source`).
    pub(crate) fn source_of(&self, token: &str) -> Option<Connection> {
        self.state
            .lock_unpoisoned()
            .records
            .get(token)
            .map(|record| record.source.clone())
    }

    fn close_where(&self, matches: impl Fn(&Record) -> bool) -> Vec<Lease> {
        let mut state = self.state.lock_unpoisoned();
        let tokens: Vec<String> = state
            .records
            .values()
            .filter(|record| matches(record))
            .map(|record| record.lease.token.clone())
            .collect();
        tokens
            .iter()
            .filter_map(|token| cancel_and_remove(&mut state, token))
            .collect()
    }
}

#[cfg(test)]
#[path = "mcp_ui_lease_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mcp_ui_lease_conformance_tests.rs"]
mod conformance_tests;
