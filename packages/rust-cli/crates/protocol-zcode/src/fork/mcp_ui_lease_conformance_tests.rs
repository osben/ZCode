//! Runs `tests/fixtures/mcp_ui_lease_conformance.json` against the Rust lease registry. The same file runs against Node
//! `McpUiInstances` (`apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/mcp-ui-lease-conformance.test.ts`); both must produce every expected outcome.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{Binding, Connection, Instances, Lease, Scope, UNAUTHORIZED};

const FIXTURE: &str = include_str!("../../tests/fixtures/mcp_ui_lease_conformance.json");

struct Runner {
    instances: Instances,
    /// The server's current connection (one server in the fixture).
    server: String,
    current: Connection,
    leases: BTreeMap<String, Lease>,
    /// call id -> (lease token, pin key).
    pins: BTreeMap<String, (String, String)>,
    sessions: Vec<String>,
}

impl Runner {
    fn alias_of(&self, lease: &Lease) -> String {
        self.leases
            .iter()
            .find(|(_, known)| known.token == lease.token)
            .map(|(alias, _)| alias.clone())
            .unwrap_or_else(|| "?".to_owned())
    }

    fn lease(&self, step: &Value, key: &str) -> Lease {
        let alias = step[key].as_str().expect("lease alias");
        self.leases
            .get(alias)
            .unwrap_or_else(|| panic!("unknown lease alias {alias}"))
            .clone()
    }

    fn source(&self, step: &Value) -> Connection {
        match &step["source"] {
            Value::String(name) if name == "current" => self.current.clone(),
            other => Connection {
                identity: other["identity"].as_str().expect("identity").to_owned(),
                generation: other["generation"].as_u64().expect("generation"),
            },
        }
    }

    fn scope_of(step: &Value) -> (String, String) {
        (
            step["session"].as_str().unwrap_or_default().to_owned(),
            step["server"].as_str().unwrap_or_default().to_owned(),
        )
    }

    fn run(&mut self, step: &Value) -> String {
        match step["op"].as_str().expect("op") {
            "open" => {
                let (session, server) = Self::scope_of(step);
                let scope = step["scope"].as_str().expect("scope").to_owned();
                let binding = Binding {
                    workspace: "/w".to_owned(),
                    account_context: None,
                    session_id: session,
                    plugin_id: "p".to_owned(),
                    server_name: server,
                    scope_id: scope,
                    resource_uri: "ui://a".to_owned(),
                    owner_web_contents_id: 7,
                };
                let source = self.source(step);
                let lease = self.instances.open(binding, &source);
                let reused = self.leases.values().any(|known| known.token == lease.token);
                let alias = step["as"].as_str().expect("as").to_owned();
                self.leases.insert(alias, lease);
                if reused { "reused" } else { "opened" }.to_owned()
            }
            "validate" => {
                let lease = self.lease(step, "lease");
                let (session, server) = Self::scope_of(step);
                let source = self.source(step);
                let scope = Scope {
                    workspace: "/w",
                    session_id: &session,
                    plugin_id: "p",
                    server_name: &server,
                };
                match self.instances.validate(&lease, scope, Some(&source)) {
                    Ok(_) => "ok".to_owned(),
                    Err(message) => {
                        assert_eq!(message, UNAUTHORIZED);
                        "unauthorized".to_owned()
                    }
                }
            }
            "retain" => {
                let lease = self.lease(step, "lease");
                let call = step["call"].as_str().expect("call").to_owned();
                match self.instances.retain(&lease.token, &call) {
                    Ok(pin) => {
                        self.pins.insert(call, (lease.token.clone(), pin));
                        "pinned".to_owned()
                    }
                    Err(message) => {
                        assert_eq!(message, UNAUTHORIZED);
                        "unauthorized".to_owned()
                    }
                }
            }
            "release" => {
                let call = step["call"].as_str().expect("call");
                if let Some((token, pin)) = self.pins.remove(call) {
                    self.instances.release(&token, &pin);
                }
                "ok".to_owned()
            }
            "busy" => {
                let lease = self.lease(step, "lease");
                if self.instances.is_busy(&lease) {
                    "busy"
                } else {
                    "idle"
                }
                .to_owned()
            }
            "close" => {
                let lease = self.lease(step, "lease");
                let only_if_idle = step["onlyIfIdle"].as_bool().unwrap_or(false);
                // Node `closeMcpUiInstance`: a busy panel under onlyIfIdle is kept open.
                if only_if_idle && self.instances.is_busy(&lease) {
                    return "not-closed".to_owned();
                }
                if self.instances.close(&lease) {
                    "closed"
                } else {
                    "not-closed"
                }
                .to_owned()
            }
            "reconnect" => {
                self.current.generation += 1;
                let mut revoked = Vec::new();
                for session in self.sessions.clone() {
                    revoked.extend(self.instances.revoke_server(&session, &self.server));
                }
                let aliases: Vec<String> =
                    revoked.iter().map(|lease| self.alias_of(lease)).collect();
                format!("revoked:{}", aliases.join(","))
            }
            "closeSession" => {
                let session = step["session"].as_str().expect("session");
                let closed = self.instances.close_session(session);
                let aliases: Vec<String> =
                    closed.iter().map(|lease| self.alias_of(lease)).collect();
                format!("closedSession:{}", aliases.join(","))
            }
            other => panic!("unknown op {other}"),
        }
    }
}

#[test]
fn the_rust_lease_registry_matches_the_shared_conformance_sequence() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let server = &fixture["server"];
    let mut sessions: Vec<String> = Vec::new();
    for step in fixture["steps"].as_array().expect("steps") {
        for key in ["session"] {
            if let Some(session) = step[key].as_str()
                && !sessions.iter().any(|known| known == session)
            {
                sessions.push(session.to_owned());
            }
        }
    }
    let mut runner = Runner {
        instances: Instances::new("rt-fixture"),
        server: server["name"].as_str().expect("name").to_owned(),
        current: Connection {
            identity: server["identity"].as_str().expect("identity").to_owned(),
            generation: server["generation"].as_u64().expect("generation"),
        },
        leases: BTreeMap::new(),
        pins: BTreeMap::new(),
        sessions,
    };
    let mut mismatches = Vec::new();
    for (index, step) in fixture["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .enumerate()
    {
        let expected = step["expect"].as_str().expect("expect");
        let actual = runner.run(step);
        if actual != expected {
            mismatches.push(format!(
                "step {index} ({}): expected {expected}, got {actual}",
                step["op"]
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "conformance mismatches:\n{}",
        mismatches.join("\n")
    );
}
