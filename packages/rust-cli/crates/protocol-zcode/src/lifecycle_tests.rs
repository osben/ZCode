use super::*;

#[test]
fn a_change_raises_the_revision_the_query_reports() {
    let lifecycles = Lifecycles::default();
    let session = SessionId::new("s1");
    assert_eq!(lifecycles.current(&session, "unloaded")["revision"], 0);
    let ready = lifecycles.changed(&session, "ready");
    assert_eq!(ready["state"], "ready");
    assert_eq!(ready["revision"], 1);
    assert_eq!(ready["lastError"], Value::Null);
    assert_eq!(lifecycles.current(&session, "ready")["revision"], 1);
    assert_eq!(lifecycles.changed(&session, "unloaded")["revision"], 2);
    assert_eq!(
        lifecycles.current(&SessionId::new("s2"), "unloaded")["revision"],
        0
    );
}
