use super::*;

fn closed() -> Notice {
    Notice::Closed {
        reason: Some("gone".to_owned()),
        session_expired: false,
    }
}

/// F11（R1-18）：连接任务忙时，同一种 `list_changed` 只留一条（收到后重新拉整份清单），关闭排在最后且不丢。
#[tokio::test]
async fn list_changes_merge_by_kind_and_close_comes_last() {
    let (sender, mut receiver) = channel();
    for _ in 0..1000 {
        sender.send(Notice::ListChanged("tools".to_owned()));
        sender.send(Notice::ListChanged("prompts".to_owned()));
    }
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    assert_eq!(
        seen,
        [
            Notice::ListChanged("tools".to_owned()),
            Notice::ListChanged("prompts".to_owned()),
            closed(),
        ]
    );
}

/// F7 PR 4: a resource update waits once per uri (a repeat of a waiting uri is the same notice), a resource list change
/// waits once, and both come in the order they first arrived, before the close.
#[tokio::test]
async fn resource_notices_merge_per_uri_and_come_before_the_close() {
    let (sender, mut receiver) = channel();
    for _ in 0..1000 {
        sender.send(Notice::ResourceUpdated("ui://a".to_owned()));
        sender.send(Notice::ResourceUpdated("ui://b".to_owned()));
        sender.send(Notice::ResourceListChanged);
    }
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    assert_eq!(
        seen,
        [
            Notice::ResourceUpdated("ui://a".to_owned()),
            Notice::ResourceUpdated("ui://b".to_owned()),
            Notice::ResourceListChanged,
            closed(),
        ]
    );
}

/// F7 PR 4 (review): at the cap a list change still waits (it is one entry, and it would otherwise be lost), while an
/// update past the cap is dropped. The overflow keeps the first `RESOURCE_NOTICE_CAP` uris in arrival order.
#[tokio::test]
async fn at_the_cap_a_list_change_still_waits_and_an_update_past_it_is_dropped() {
    let cap = 1024;
    let (sender, mut receiver) = channel();
    for index in 0..=cap {
        sender.send(Notice::ResourceUpdated(format!("ui://{index}")));
    }
    sender.send(Notice::ResourceListChanged);
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    let mut expected: Vec<Notice> = (0..cap)
        .map(|index| Notice::ResourceUpdated(format!("ui://{index}")))
        .collect();
    expected.push(Notice::ResourceListChanged);
    expected.push(closed());
    assert_eq!(seen, expected);
}

/// F7 PR 4 (review): the waiting uris are bounded by their bytes too (a server names them). The second uri does not fit
/// the 1 MiB allowance and is dropped; a list change still waits.
#[tokio::test]
async fn waiting_uris_are_bounded_by_their_bytes_too() {
    let allowance = 1024 * 1024;
    let (sender, mut receiver) = channel();
    sender.send(Notice::ResourceUpdated("a".repeat(allowance * 3 / 4)));
    sender.send(Notice::ResourceUpdated("b".repeat(allowance * 3 / 4)));
    sender.send(Notice::ResourceListChanged);
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    assert_eq!(
        seen,
        [
            Notice::ResourceUpdated("a".repeat(allowance * 3 / 4)),
            Notice::ResourceListChanged,
            closed(),
        ]
    );
}

/// F7 PR 4 (review): only the list kinds the connection task refreshes are queued (tools and prompts). A kind a server
/// makes up is dropped, so the queue is bounded by the kinds the manager knows.
#[tokio::test]
async fn only_the_list_kinds_the_connection_refreshes_wait() {
    let (sender, mut receiver) = channel();
    sender.send(Notice::ListChanged("tools".to_owned()));
    for index in 0..1000 {
        sender.send(Notice::ListChanged(format!("made-up-{index}")));
    }
    sender.send(Notice::ListChanged("prompts".to_owned()));
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    assert_eq!(
        seen,
        [
            Notice::ListChanged("tools".to_owned()),
            Notice::ListChanged("prompts".to_owned()),
            closed(),
        ]
    );
}

/// F7 PR 4 (review): resource notices go before a waiting tools list change, so a busy list cannot starve them.
#[tokio::test]
async fn resource_notices_go_before_a_waiting_list_change() {
    let (sender, mut receiver) = channel();
    sender.send(Notice::ListChanged("tools".to_owned()));
    sender.send(Notice::ResourceUpdated("ui://a".to_owned()));
    sender.send(closed());
    drop(sender);
    let mut seen = Vec::new();
    while let Some(notice) = receiver.recv().await {
        seen.push(notice);
    }
    assert_eq!(
        seen,
        [
            Notice::ResourceUpdated("ui://a".to_owned()),
            Notice::ListChanged("tools".to_owned()),
            closed(),
        ]
    );
}

/// F7 PR 4 (review, round 5): a uri taken away waits again, and its bytes come back with it (the queue and its set reset
/// together). Regression check of the take path.
#[tokio::test]
async fn a_uri_taken_away_waits_again_and_frees_its_bytes() {
    let (sender, mut receiver) = channel();
    let big = "a".repeat(600 * 1024);
    sender.send(Notice::ResourceUpdated(big.clone()));
    assert_eq!(
        receiver.recv().await,
        Some(Notice::ResourceUpdated(big.clone()))
    );
    sender.send(Notice::ResourceUpdated(big.clone()));
    assert_eq!(
        receiver.recv().await,
        Some(Notice::ResourceUpdated(big.clone())),
        "the same uri waits again once taken away"
    );
    // The bytes of the taken uri are free: a second uri of the same size fits the 1 MiB allowance.
    sender.send(Notice::ResourceUpdated("b".repeat(600 * 1024)));
    assert_eq!(
        receiver.recv().await,
        Some(Notice::ResourceUpdated("b".repeat(600 * 1024)))
    );
}

/// F7 PR 4 (review, round 5): a resource list change taken away waits again.
#[tokio::test]
async fn a_resource_list_change_taken_away_waits_again() {
    let (sender, mut receiver) = channel();
    sender.send(Notice::ResourceListChanged);
    assert_eq!(receiver.recv().await, Some(Notice::ResourceListChanged));
    sender.send(Notice::ResourceListChanged);
    assert_eq!(receiver.recv().await, Some(Notice::ResourceListChanged));
}

/// 取走之后再来的同一种照常送达。
#[tokio::test]
async fn a_kind_taken_away_can_arrive_again() {
    let (sender, mut receiver) = channel();
    sender.send(Notice::ListChanged("tools".to_owned()));
    assert_eq!(
        receiver.recv().await,
        Some(Notice::ListChanged("tools".to_owned()))
    );
    sender.send(Notice::ListChanged("tools".to_owned()));
    assert_eq!(
        receiver.recv().await,
        Some(Notice::ListChanged("tools".to_owned()))
    );
}
