use super::*;

fn checksum(bytes: &[u8]) -> String {
    format!("sha256:{}", rust_cli_base::hash::sha256_hex(bytes))
}

fn begin(bytes: &[u8], chunks: u64) -> Begin {
    Begin {
        connection_id: "conn".into(),
        upload_id: "up-1".into(),
        session_id: "sess".into(),
        file_name: "note.txt".into(),
        mime: "text/plain".into(),
        total_bytes: bytes.len() as u64,
        total_chunks: chunks,
        checksum: checksum(bytes),
    }
}

fn target() -> Target {
    Target {
        connection_id: "conn".into(),
        upload_id: "up-1".into(),
        session_id: "sess".into(),
    }
}

#[test]
fn stages_validates_and_commits_once() {
    let mut registry = Registry::default();
    let data = b"hello world";
    assert_eq!(
        registry.begin(&begin(data, 2), 0),
        Ok(Began::Staging { next_chunk: 0 })
    );
    assert_eq!(registry.chunk(&target(), 0, b"hello ".to_vec(), 1), Ok(1));
    // A repeated chunk with the same bytes answers the same position.
    assert_eq!(registry.chunk(&target(), 0, b"hello ".to_vec(), 1), Ok(1));
    assert_eq!(
        registry.chunk(&target(), 0, b"HELLO ".to_vec(), 1),
        Err("fault.attachment.chunkConflict".into())
    );
    assert_eq!(
        registry.chunk(&target(), 2, b"x".to_vec(), 1),
        Err("fault.attachment.chunkGap".into())
    );
    assert_eq!(
        registry.commit(&target(), 2),
        Err("fault.attachment.uploadIncomplete".into())
    );
    assert_eq!(registry.chunk(&target(), 1, b"world".to_vec(), 2), Ok(2));
    let Ok(Commit::Store { bytes, .. }) = registry.commit(&target(), 3) else {
        panic!("expected bytes to store");
    };
    assert_eq!(bytes, data);
    assert_eq!(
        registry.commit(&target(), 3),
        Err("fault.attachment.commitInProgress".into())
    );
    registry.committed(&target(), "zcode-artifact://sess/a".into(), 4);
    assert_eq!(
        registry.commit(&target(), 5),
        Ok(Commit::Done("zcode-artifact://sess/a".into()))
    );
    assert_eq!(
        registry.begin(&begin(data, 2), 5),
        Ok(Began::Committed {
            next_chunk: 2,
            reference: "zcode-artifact://sess/a".into()
        })
    );
}

#[test]
fn refuses_a_checksum_mismatch_and_conflicting_begin() {
    let mut registry = Registry::default();
    let mut params = begin(b"abc", 1);
    params.checksum = checksum(b"abd");
    registry.begin(&params, 0).unwrap();
    registry.chunk(&target(), 0, b"abc".to_vec(), 0).unwrap();
    assert_eq!(
        registry.commit(&target(), 0),
        Err("fault.attachment.checksumMismatch".into())
    );
    assert_eq!(
        registry.begin(&begin(b"abc", 1), 0),
        Err("fault.attachment.beginConflict".into())
    );
}

#[test]
fn limits_concurrency_expires_and_clears_connections() {
    let mut registry = Registry::default();
    for n in 0..MAX_CONCURRENT {
        let mut params = begin(b"x", 1);
        params.upload_id = format!("up-{n}");
        registry.begin(&params, 0).unwrap();
    }
    let mut extra = begin(b"x", 1);
    extra.upload_id = "up-extra".into();
    assert_eq!(
        registry.begin(&extra, 0),
        Err("fault.attachment.tooManyUploads".into())
    );
    registry.clear_connection("conn");
    assert!(registry.begin(&extra, 0).is_ok());
    // Past the TTL the staged upload is gone.
    assert_eq!(
        registry.chunk(
            &Target {
                upload_id: "up-extra".into(),
                ..target()
            },
            0,
            b"x".to_vec(),
            TTL_MS + 1
        ),
        Err("fault.attachment.uploadNotFound".into())
    );
}

#[test]
fn a_failed_store_can_be_committed_again_and_abort_keeps_a_commit_in_flight() {
    let mut registry = Registry::default();
    registry.begin(&begin(b"abc", 1), 0).unwrap();
    registry.chunk(&target(), 0, b"abc".to_vec(), 0).unwrap();
    assert!(matches!(
        registry.commit(&target(), 0),
        Ok(Commit::Store { .. })
    ));
    registry.abort(&target(), 0);
    registry.release(&target());
    assert!(matches!(
        registry.commit(&target(), 0),
        Ok(Commit::Store { .. })
    ));
}

#[test]
fn rejects_bad_metadata() {
    let mut registry = Registry::default();
    let mut zero = begin(b"", 1);
    zero.total_bytes = 0;
    assert_eq!(
        registry.begin(&zero, 0),
        Err("fault.attachment.invalidParams".into())
    );
    let mut short = begin(&[0; 10], 1);
    short.total_bytes = (CHUNK_MAX_BYTES + 1) as u64;
    assert_eq!(
        registry.begin(&short, 0),
        Err("fault.attachment.chunkCountInsufficient".into())
    );
}
