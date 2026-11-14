//! Fork: the transcript file is readable with its text until it is removed.

use rust_cli_kernel_api::hooks::HookTranscripts;

use super::LocalHookTranscripts;

#[tokio::test]
async fn the_transcript_is_readable_until_its_directory_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let transcripts = LocalHookTranscripts::new(root.path().to_path_buf());
    let file = transcripts
        .create("zcode-hook-1", "{\"message\":{}}\n")
        .await
        .unwrap();
    assert_eq!(
        file.path,
        root.path()
            .join("zcode-hook-1/transcript.jsonl")
            .to_string_lossy()
    );
    let text = rust_cli_fs::read_optional(std::path::Path::new(&file.path))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text, b"{\"message\":{}}\n");
    let empty = transcripts.create("zcode-hook-2", "").await.unwrap();
    assert!(rust_cli_fs::is_file(std::path::Path::new(&empty.path)).await);
    transcripts.remove(&file).await.unwrap();
    assert!(!rust_cli_fs::is_dir(std::path::Path::new(&file.dir)).await);
    // Removing twice is not an error.
    transcripts.remove(&file).await.unwrap();
}
