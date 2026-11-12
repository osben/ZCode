use super::*;

#[test]
fn started_subscribers_get_only_what_came_after_their_first_frame() {
    let mut log = TopicLog::<&str>::new("e1");
    assert_eq!(log.record(vec!["a"]), 1);
    log.subscribe("s1", "c1");
    // 首帧之前没有增量。
    log.record(vec!["b"]);
    assert!(log.flush().is_empty());
    assert_eq!(log.start("s1"), Some(2));
    log.record(vec!["c", "d"]);
    log.record(Vec::new());
    log.subscribe("s2", "c2");
    log.record(vec!["e"]);
    assert_eq!(log.start("s2"), Some(4));
    log.record(vec!["f"]);
    assert_eq!(
        log.flush(),
        vec![
            Batch {
                subscription: "s1".to_owned(),
                from: 2,
                to: 5,
                deltas: vec!["c", "d", "e", "f"],
            },
            Batch {
                subscription: "s2".to_owned(),
                from: 4,
                to: 5,
                deltas: vec!["f"],
            },
        ]
    );
    assert!(log.flush().is_empty());
    assert_eq!(log.epoch(), "e1");
}

#[test]
fn the_same_connection_replaces_its_subscription() {
    let mut log = TopicLog::<u8>::new("e");
    assert_eq!(log.subscribe("s1", "c1"), None);
    assert_eq!(log.subscribe("s2", "c1"), Some("s1".to_owned()));
    assert!(!log.has_subscription("s1"));
    assert_eq!(log.start("s1"), None);
    log.subscribe("s3", "c2");
    assert_eq!(log.drop_connection("c1"), vec!["s2".to_owned()]);
    assert!(log.unsubscribe("s3"));
    assert!(log.subscribers().is_empty());
}

#[test]
fn a_restarted_subscription_waits_for_a_new_first_frame() {
    let mut log = TopicLog::<u8>::new("e");
    log.subscribe("s1", "c1");
    log.start("s1");
    log.record(vec![1]);
    assert!(log.restart("s1"));
    log.record(vec![2]);
    assert!(log.flush().is_empty());
    assert_eq!(log.start("s1"), Some(2));
    assert!(!log.restart("gone"));
}

/// Fork: a log opened on a session with history starts at the kernel's last event sequence (Node's topic
/// sequence is the durable event sequence), and later records continue from it.
#[test]
fn a_log_with_a_base_starts_at_that_sequence() {
    let mut log = TopicLog::<&str>::with_base("e1", 7);
    log.subscribe("s1", "c1");
    assert_eq!(log.start("s1"), Some(7));
    assert_eq!(log.record(vec!["a"]), 8);
    assert_eq!(
        log.flush(),
        vec![Batch {
            subscription: "s1".to_owned(),
            from: 7,
            to: 8,
            deltas: vec!["a"],
        }]
    );
}
