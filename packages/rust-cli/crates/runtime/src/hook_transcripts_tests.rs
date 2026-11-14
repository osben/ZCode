//! Fork: the transcript file is readable with its text until it is removed, and stays inside the temp root.

use rust_cli_kernel_api::hooks::{HookTranscript, HookTranscripts};

use super::LocalHookTranscripts;

#[tokio::test]
async fn the_transcript_is_readable_until_its_directory_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    let file = transcripts.locate("zcode-hook-1").unwrap();
    assert_eq!(
        file.path,
        root.path()
            .join("zcode-hook-1/transcript.jsonl")
            .to_string_lossy()
    );
    // Locating touches nothing.
    assert!(!rust_cli_fs::is_dir(std::path::Path::new(&file.dir)).await);
    transcripts.create(&file, "{\"message\":{}}\n").unwrap();
    let text = rust_cli_fs::read_optional(std::path::Path::new(&file.path))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text, b"{\"message\":{}}\n");
    let empty = transcripts.locate("zcode-hook-2").unwrap();
    transcripts.create(&empty, "").unwrap();
    assert!(rust_cli_fs::is_file(std::path::Path::new(&empty.path)).await);
    transcripts.remove(&file).await.unwrap();
    assert!(!rust_cli_fs::is_dir(std::path::Path::new(&file.dir)).await);
    // Removing twice, or a directory never created, is not an error.
    transcripts.remove(&file).await.unwrap();
    let never = transcripts.locate("zcode-hook-3").unwrap();
    transcripts.remove(&never).await.unwrap();
}

#[tokio::test]
async fn creating_replaces_an_existing_file_with_owner_only_access() {
    let root = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    let file = transcripts.locate("zcode-hook-1").unwrap();
    transcripts.create(&file, "first text\n").unwrap();
    transcripts.create(&file, "x\n").unwrap();
    let text = rust_cli_fs::read_optional(std::path::Path::new(&file.path))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text, b"x\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (path, expected) in [(&file.path, 0o600), (&file.dir, 0o700)] {
            #[allow(
                clippy::disallowed_methods,
                reason = "the test reads the mode it checks"
            )]
            let metadata = std::fs::metadata(path).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o777, expected, "{path}");
        }
    }
}

#[test]
fn a_name_must_be_one_plain_path_component() {
    let root = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    for name in ["", ".", "..", "../escape", "a/b", "/abs"] {
        let error = transcripts.locate(name).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "{name:?}");
    }
}

#[tokio::test]
async fn remove_refuses_a_directory_outside_the_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    let forged = |dir: std::path::PathBuf| HookTranscript {
        path: dir.join("transcript.jsonl").to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
    };
    for dir in [
        outside.path().to_path_buf(),
        root.path().to_path_buf(),
        root.path().join("a").join("b"),
        root.path().join(".."),
    ] {
        let error = transcripts.remove(&forged(dir.clone())).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "{dir:?}");
        let error = transcripts
            .remove_blocking(&forged(dir.clone()))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "{dir:?}");
    }
    assert!(rust_cli_fs::is_dir(outside.path()).await);
    assert!(rust_cli_fs::is_dir(root.path()).await);
}

/// The drop guard's last resort removes the directory synchronously; a missing one is not an error.
#[tokio::test]
async fn remove_blocking_removes_the_directory() {
    let root = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    let file = transcripts.locate("zcode-hook-1").unwrap();
    transcripts.create(&file, "{}\n").unwrap();
    transcripts.remove_blocking(&file).unwrap();
    assert!(!rust_cli_fs::is_dir(std::path::Path::new(&file.dir)).await);
    transcripts.remove_blocking(&file).unwrap();
}
