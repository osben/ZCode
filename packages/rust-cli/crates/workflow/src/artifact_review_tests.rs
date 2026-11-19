//! Cases from the ocr review of PR #563 (round 1) for artifact publish.

use crate::artifact_publish::{ArtifactFsPort, FsFault, PublishDeps, execute_artifact_publish};
use crate::engine_artifacts::ArtifactPublishRequest;
use std::path::{Path, PathBuf};

struct NoFs;

impl ArtifactFsPort for NoFs {
    fn read_file(&self, _path: &Path, _max_bytes: usize) -> Result<Vec<u8>, FsFault> {
        Err(FsFault::NotFound)
    }

    fn real_path(&self, path: &Path) -> Result<PathBuf, FsFault> {
        Ok(path.to_path_buf())
    }
}

struct NoStore;

impl crate::artifact_publish::ArtifactStorePort for NoStore {
    fn supports_binary(&self) -> bool {
        true
    }

    fn write(
        &self,
        _write: &crate::artifact_publish::StoreWrite<'_>,
    ) -> Result<crate::artifact_publish::StoreReceipt, String> {
        Err("not reached".to_owned())
    }
}

/// Finding 9: an absent markdown content is rendered as `null`, the same word the other shape errors use.
#[test]
fn an_absent_markdown_content_is_reported_as_null_like_the_other_shape_errors() {
    let fs = NoFs;
    let store = NoStore;
    let deps = PublishDeps {
        fs: &fs,
        store: Some(&store),
        parent_session_id: Some("sess_parent"),
        cwd: Path::new("/ws/root"),
        now_ms: 1,
    };
    let request = ArtifactPublishRequest {
        run_id: "run-1".to_owned(),
        site_id: "site".to_owned(),
        ordinal: 1,
        op: "markdown".to_owned(),
        id: "summary".to_owned(),
        version: 1,
        path: None,
        content: None,
        opts: None,
    };
    let error = execute_artifact_publish(&deps, &request).expect_err("content is required");
    assert!(error.message.ends_with("got null."), "{}", error.message);
}
