use super::*;

fn conn(generation: u64) -> Connection {
    Connection {
        identity: "id-A".to_owned(),
        generation,
    }
}

fn binding(scope: &str, session: &str) -> Binding {
    Binding {
        workspace: "/w".to_owned(),
        account_context: None,
        session_id: session.to_owned(),
        plugin_id: "p".to_owned(),
        server_name: "s1".to_owned(),
        scope_id: scope.to_owned(),
        resource_uri: "ui://a".to_owned(),
        owner_web_contents_id: 7,
    }
}

fn scope<'a>(session: &'a str, server: &'a str) -> Scope<'a> {
    Scope {
        workspace: "/w",
        session_id: session,
        plugin_id: "p",
        server_name: server,
    }
}

#[test]
fn open_binds_the_lease_to_the_connection_and_the_runtime() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    assert_eq!(lease.runtime_id, "rt-1");
    assert_eq!(
        lease.generation, 1,
        "the first lease of a process is generation 1"
    );
    assert!(!lease.token.is_empty());
    assert!(!lease.app_identity.is_empty());
    let active = instances
        .validate(&lease, scope("sess", "s1"), Some(&conn(1)))
        .expect("the lease is valid on its own connection");
    assert!(!active.cancel.is_cancelled());
}

#[test]
fn open_reuses_the_lease_of_the_same_binding_and_connection() {
    let instances = Instances::new("rt-1");
    let first = instances.open(binding("scope1", "sess"), &conn(1));
    let again = instances.open(binding("scope1", "sess"), &conn(1));
    assert_eq!(first, again);
}

#[test]
fn open_on_a_new_generation_closes_the_previous_lease() {
    let instances = Instances::new("rt-1");
    let old = instances.open(binding("scope1", "sess"), &conn(1));
    let new = instances.open(binding("scope1", "sess"), &conn(2));
    assert_ne!(old.token, new.token);
    assert!(instances.validate(&old, scope("sess", "s1"), None).is_err());
    assert!(
        instances
            .validate(&new, scope("sess", "s1"), Some(&conn(2)))
            .is_ok()
    );
}

#[test]
fn a_scope_mismatch_is_refused_without_closing_the_lease() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    assert_eq!(
        instances
            .validate(&lease, scope("other-session", "s1"), Some(&conn(1)))
            .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        instances
            .validate(&lease, scope("sess", "other-server"), Some(&conn(1)))
            .unwrap_err(),
        UNAUTHORIZED
    );
    assert!(
        instances
            .validate(&lease, scope("sess", "s1"), Some(&conn(1)))
            .is_ok(),
        "a request for another server must not close a legitimate panel"
    );
}

#[test]
fn a_source_from_another_generation_closes_the_lease() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(2));
    assert_eq!(
        instances
            .validate(&lease, scope("sess", "s1"), Some(&conn(1)))
            .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        instances
            .validate(&lease, scope("sess", "s1"), Some(&conn(2)))
            .unwrap_err(),
        UNAUTHORIZED,
        "the stale request closed it: the current connection cannot revive it"
    );
}

#[test]
fn a_missing_source_is_refused() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    assert_eq!(
        instances
            .validate(&lease, scope("sess", "s1"), None)
            .unwrap_err(),
        UNAUTHORIZED
    );
}

#[test]
fn revoke_server_cancels_the_calls_then_closes_the_leases_of_that_server() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    let active = instances
        .validate(&lease, scope("sess", "s1"), Some(&conn(1)))
        .unwrap();
    let pin = instances.retain(&lease.token, "call-1").unwrap();
    assert!(instances.is_busy(&lease));
    let revoked = instances.revoke_server("sess", "s1");
    assert_eq!(revoked, vec![lease.clone()]);
    assert!(
        active.cancel.is_cancelled(),
        "in-flight calls see the cancel"
    );
    assert!(
        instances
            .validate(&lease, scope("sess", "s1"), Some(&conn(1)))
            .is_err()
    );
    instances.release(&lease.token, &pin);
}

#[test]
fn revoke_server_leaves_other_servers_and_sessions_alone() {
    let instances = Instances::new("rt-1");
    let kept = instances.open(
        Binding {
            server_name: "s2".to_owned(),
            ..binding("scope2", "sess")
        },
        &conn(1),
    );
    let other_session = instances.open(binding("scope3", "other"), &conn(1));
    let revoked = instances.revoke_server("sess", "s1");
    assert!(revoked.is_empty());
    assert!(
        instances
            .validate(&kept, scope("sess", "s2"), Some(&conn(1)))
            .is_ok()
    );
    assert!(
        instances
            .validate(&other_session, scope("other", "s1"), Some(&conn(1)))
            .is_ok()
    );
}

#[test]
fn close_is_once_and_close_session_returns_what_it_closed() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    assert!(instances.close(&lease));
    assert!(!instances.close(&lease));
    let second = instances.open(binding("scope2", "sess"), &conn(1));
    assert_eq!(instances.close_session("sess"), vec![second]);
    assert!(instances.close_session("sess").is_empty());
}

#[test]
fn retain_refuses_a_closed_lease_and_busy_tracks_the_pins() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(1));
    assert!(!instances.is_busy(&lease));
    let pin = instances.retain(&lease.token, "call-1").unwrap();
    assert!(instances.is_busy(&lease));
    instances.release(&lease.token, &pin);
    assert!(!instances.is_busy(&lease));
    instances.close(&lease);
    assert_eq!(
        instances.retain(&lease.token, "call-2").unwrap_err(),
        UNAUTHORIZED
    );
}

#[test]
fn source_of_reports_the_bound_connection_while_the_lease_is_live() {
    let instances = Instances::new("rt-1");
    let lease = instances.open(binding("scope1", "sess"), &conn(3));
    assert_eq!(instances.source_of(&lease.token), Some(conn(3)));
    instances.close(&lease);
    assert_eq!(instances.source_of(&lease.token), None);
}
