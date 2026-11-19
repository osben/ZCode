//! The owner's world wiring: a read or publish runs on a worker, its outcome comes back through the mailbox, and the
//! engine settles the ticket (W6b part 4). Node: `workflow-driver.test.ts` row 11 ("world reads: glob and read through
//! the fs port feed a typed ask") and the world-read and artifact cases of the driver suite.

#![allow(clippy::result_large_err)]

use crate::actor_mailbox::ActorMailbox;
use crate::artifact_publish::{
    ArtifactFsPort, ArtifactStorePort, FsFault, StoreContent, StoreReceipt, StoreWrite,
};
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, owner};
use crate::error::{ErrorCode, WorkflowError};
use crate::journal::MemoryJournal;
use crate::world_host::{ArtifactWiring, WorldWiring};
use crate::world_read::{GlobHits, GrepHits, RunOutcome, RunRequest, WorldReadPorts};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A read port that answers glob and read from canned values.
struct Fs {
    files: Vec<String>,
    text: Result<String, String>,
    panic_on_glob: bool,
}

impl WorldReadPorts for Fs {
    fn glob(&self, _pattern: &str, _limit: usize) -> Result<GlobHits, String> {
        if self.panic_on_glob {
            panic!("the port broke");
        }
        Ok(GlobHits {
            total: self.files.len(),
            files: self.files.clone(),
        })
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        self.text.clone()
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<GrepHits, String> {
        Ok(GrepHits::default())
    }

    fn run(&self, _request: &RunRequest) -> Result<RunOutcome, String> {
        Err("not used".to_owned())
    }
}

fn fs(files: &[&str]) -> Fs {
    Fs {
        files: files.iter().map(|f| format!("/ws/root/{f}")).collect(),
        text: Ok("text".to_owned()),
        panic_on_glob: false,
    }
}

/// Serve mailbox requests until the outcome of `ticket` is in, then return it.
fn settle(
    mailbox: &ActorMailbox,
    owner: &mut ActorDriverOwner<MemoryJournal, Recording>,
    ticket: u64,
) -> Result<Value, WorkflowError> {
    for _ in 0..4 {
        if let Some(outcome) = owner
            .take_outcomes()
            .into_iter()
            .find(|o| o.ticket == ticket)
        {
            return outcome.result;
        }
        mailbox
            .serve_next(owner)
            .expect("a worker's settlement is served");
    }
    panic!("the ticket never settled");
}

fn wired(
    reads: Fs,
    handle: crate::actor_mailbox::ActorHandle,
    artifacts: Option<ArtifactWiring>,
) -> ActorDriverOwner<MemoryJournal, Recording> {
    let (owner, _sessions) = owner();
    owner.with_world(WorldWiring {
        reads: Arc::new(reads),
        cwd: PathBuf::from("/ws/root"),
        artifacts,
        done: handle,
    })
}

#[test]
fn a_glob_through_the_read_port_feeds_its_sorted_relative_list_to_the_ticket() {
    let (mailbox, handle) = ActorMailbox::new();
    let mut owner = wired(fs(&["b.md", "sub/a.md"]), handle, None);
    let ticket = owner
        .world_read("site", "glob", vec![json!("**/*.md")])
        .expect("the world read is admitted");
    let value = settle(&mailbox, &mut owner, ticket).expect("the glob settles");
    assert_eq!(value, json!(["b.md", "sub/a.md"]));
}

#[test]
fn a_read_through_the_port_settles_with_the_text() {
    let (mailbox, handle) = ActorMailbox::new();
    let mut owner = wired(fs(&[]), handle, None);
    let ticket = owner
        .world_read("site", "read", vec![json!("a.md")])
        .expect("admitted");
    assert_eq!(settle(&mailbox, &mut owner, ticket).unwrap(), json!("text"));
}

#[test]
fn a_port_fault_fails_the_node_with_a_catchable_driver_error() {
    let (mailbox, handle) = ActorMailbox::new();
    let mut broken = fs(&[]);
    broken.text = Err("disk gone".to_owned());
    let mut owner = wired(broken, handle, None);
    let ticket = owner
        .world_read("site", "read", vec![json!("a.md")])
        .expect("admitted");
    let error = settle(&mailbox, &mut owner, ticket).expect_err("the read fails");
    assert_eq!(error.code, ErrorCode::DriverError);
    assert_eq!(error.message, "disk gone");
}

#[test]
fn a_panicking_port_fails_the_node_instead_of_leaving_it_running() {
    let (mailbox, handle) = ActorMailbox::new();
    let mut panicking = fs(&["x.md"]);
    panicking.panic_on_glob = true;
    let mut owner = wired(panicking, handle, None);
    let ticket = owner
        .world_read("site", "glob", vec![json!("*")])
        .expect("admitted");
    let error = settle(&mailbox, &mut owner, ticket).expect_err("the panic is a failure");
    assert_eq!(error.code, ErrorCode::DriverError);
}

struct Store;

impl ArtifactStorePort for Store {
    fn supports_binary(&self) -> bool {
        false
    }

    fn write(&self, write: &StoreWrite<'_>) -> Result<StoreReceipt, String> {
        Ok(StoreReceipt {
            bytes: match write.content {
                StoreContent::Text(text) => text.len(),
                StoreContent::Binary(bytes) => bytes.len(),
            },
            uri: format!(
                "zcode-artifact://{}/{}",
                write.session_id, write.tool_call_id
            ),
        })
    }
}

struct NoFiles;

impl ArtifactFsPort for NoFiles {
    fn read_file(&self, _path: &Path, _max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        Err(FsFault::NotFound)
    }

    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        Ok(path.to_path_buf())
    }
}

fn now() -> u64 {
    1_700_000_000_123
}

#[test]
fn a_markdown_publish_is_written_to_the_store_and_settles_with_its_version_record() {
    let (mailbox, handle) = ActorMailbox::new();
    let artifacts = ArtifactWiring {
        fs: Arc::new(NoFiles),
        store: Some(Arc::new(Store)),
        parent_session_id: Some("ses_parent".to_owned()),
        now_ms: now,
    };
    let mut owner = wired(fs(&[]), handle, Some(artifacts));
    let ticket = owner
        .publish_artifact("site", "markdown", &[json!("report"), json!("# hi")])
        .expect("admitted");
    // The ticket settles with `{id, version}` (Node `settleArtifactPublish`); the full record is journaled.
    let settled = settle(&mailbox, &mut owner, ticket).expect("the publish settles");
    assert_eq!(settled, json!({"id": "report", "version": 1}));
}

#[test]
fn without_a_store_the_engine_refuses_a_publish() {
    let (mailbox, handle) = ActorMailbox::new();
    let mut owner = wired(fs(&[]), handle, None);
    let ticket = owner
        .publish_artifact("site", "markdown", &[json!("report"), json!("# hi")])
        .expect("admitted");
    let error = settle(&mailbox, &mut owner, ticket).expect_err("no store");
    assert_eq!(error.code, ErrorCode::ArtifactStoreUnavailable);
}
