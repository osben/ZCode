//! The per-ask gate of Node's `askMutating` (workflow-driver-tool-activity.ts: `reported` is local to one ask's
//! subscription): the first workspace-mutating call of an ask reaches the owner, and no later call of that ask does.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

use crate::actor_turn::{FirstMutating, MutatingNotify};

#[derive(Default)]
struct Counting(AtomicUsize);

#[async_trait]
impl MutatingNotify for Counting {
    async fn ask_mutating(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_nudged_turn_of_the_same_ask_does_not_fire_again() {
    let counting = Arc::new(Counting::default());
    // One gate per ask: the bridge creates it with the runner, which serves every turn of the ask.
    let ask = FirstMutating::new(counting.clone());
    ask.mutating().await;
    ask.mutating().await;
    assert_eq!(counting.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_new_ask_fires_again() {
    let counting = Arc::new(Counting::default());
    FirstMutating::new(counting.clone()).mutating().await;
    FirstMutating::new(counting.clone()).mutating().await;
    assert_eq!(counting.0.load(Ordering::SeqCst), 2);
}
