use super::*;

fn id(text: &str) -> SessionId {
    SessionId::new(text)
}

/// A close makes the entry unwanted and wakes its task; a reopen before the task looks makes it wanted again, and
/// the task stays (no second claim is possible while the entry exists).
#[test]
fn a_reopen_before_the_task_looks_keeps_the_same_entry() {
    let agents = Agents::new();
    let mut routes = Routes::default();
    routes.opened(&id("root"));
    let started = routes.claim(&id("child"), &id("root")).unwrap();
    routes.closing(&id("root"));
    routes.reconcile(&agents);
    assert!(started.wake.has_changed().unwrap());
    routes.opened(&id("root"));
    routes.reconcile(&agents);
    assert!(routes.claim(&id("child"), &id("root")).is_none());
    assert!(!routes.leave_if_unwanted(&id("child"), started.id));
}

/// An unwanted entry is removed by its own task only, and then a new claim succeeds.
#[test]
fn only_the_entrys_task_removes_it() {
    let agents = Agents::new();
    let mut routes = Routes::default();
    routes.opened(&id("root"));
    let started = routes.claim(&id("child"), &id("root")).unwrap();
    routes.closing(&id("root"));
    routes.reconcile(&agents);
    routes.remove(&id("child"), started.id + 1);
    assert!(routes.claim(&id("child"), &id("root")).is_none());
    assert!(routes.leave_if_unwanted(&id("child"), started.id));
    assert!(routes.claim(&id("child"), &id("root")).is_some());
}

/// An adoption is void once its session closed or reopened, and reads again after an erase.
#[test]
fn an_adoption_claims_only_for_its_own_open_and_epoch() {
    let mut routes = Routes::default();
    let first = routes.opened(&id("root"));
    let second = routes.opened(&id("root"));
    assert!(matches!(
        routes.adopt(&id("root"), first, &[id("child")]),
        Adopted::Closed
    ));
    routes.erased(&[id("other")]);
    let Adopted::Retry(epoch) = routes.adopt(&id("root"), second, &[id("child")]) else {
        panic!("an erase must invalidate the read");
    };
    assert!(matches!(
        routes.adopt(&id("root"), (second.0, epoch), &[id("child")]),
        Adopted::Claimed(claimed) if claimed.len() == 1
    ));
}

/// Erasing a child or its root makes its entry unwanted even while the root stays open.
#[test]
fn an_erased_child_is_not_wanted() {
    let agents = Agents::new();
    let mut routes = Routes::default();
    routes.opened(&id("root"));
    routes.claim(&id("child"), &id("root")).unwrap();
    assert!(routes.want(&agents, &id("child")));
    routes.erased(&[id("child")]);
    assert!(!routes.want(&agents, &id("child")));
}
