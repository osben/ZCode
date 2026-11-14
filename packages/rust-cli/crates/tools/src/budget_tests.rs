use async_trait::async_trait;
use rust_cli_kernel_api::ids::ArtifactId;
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactRef, StoreError};

use super::*;

struct Store;

#[async_trait]
impl ArtifactStore for Store {
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError> {
        Ok(ArtifactRef {
            session: session.clone(),
            id: ArtifactId::new("art_1"),
            purpose,
            media_type,
            size: bytes.len() as u64,
        })
    }

    async fn get(&self, _artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError> {
        Ok(Vec::new())
    }
}

fn output(text: &str) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text {
            text: text.to_owned(),
        }],
        is_error: false,
        display: Value::Null,
    }
}

fn first(output: &ToolOutput) -> &str {
    match &output.content[0] {
        ToolResultContent::Text { text } => text,
        ToolResultContent::Image { .. }
        | ToolResultContent::Document { .. }
        | ToolResultContent::ToolReference { .. } => "",
    }
}

#[tokio::test]
async fn results_over_the_threshold_are_persisted_with_a_preview() {
    let session = SessionId::new("sess_1");
    let line = "x".repeat(99);
    let long = vec![line.as_str(); 300].join("\n");
    let persisted = apply(
        output(&long),
        "Grep",
        Some(Limit::Chars(20_000)),
        &session,
        &Store,
    )
    .await;
    let text = first(&persisted);
    assert!(text.starts_with("<persisted-output>\nOutput too large (29.3KB). Full output saved to: zcode-artifact://sess_1/art_1\n\nPreview (first 2KB):\n"));
    assert!(text.ends_with("\n...\n</persisted-output>"));
    let short = apply(
        output("small"),
        "Grep",
        Some(Limit::Chars(20_000)),
        &session,
        &Store,
    )
    .await;
    assert_eq!(first(&short), "small");
    let unlimited = apply(output(&long), "Read", None, &session, &Store).await;
    assert_eq!(first(&unlimited), long);
    let empty = apply(
        output("  "),
        "Glob",
        Some(Limit::Chars(100_000)),
        &session,
        &Store,
    )
    .await;
    assert_eq!(first(&empty), "(Glob completed with no output)");
}

/// Fork: a Node byte budget (`resultBudget` with the artifact strategy): UTF-8 bytes against the declared limit, no
/// 50 000 cap, and Node's generic envelope. 60 000 ASCII characters stay inline; 40 000 CJK characters (120 000 bytes)
/// are persisted.
#[tokio::test]
async fn a_byte_budget_counts_utf8_bytes_without_the_character_cap() {
    let session = SessionId::new("sess_1");
    let ascii = "a".repeat(60_000);
    let kept = apply(
        output(&ascii),
        "LSP",
        Some(Limit::Bytes(100_000)),
        &session,
        &Store,
    )
    .await;
    assert_eq!(first(&kept), ascii);
    let cjk = "語".repeat(40_000);
    let persisted = apply(
        output(&cjk),
        "LSP",
        Some(Limit::Bytes(100_000)),
        &session,
        &Store,
    )
    .await;
    let text = first(&persisted);
    assert!(text.starts_with("<persisted-output>\nOutput too large (120 KB). Full output saved to: zcode-artifact://sess_1/art_1\n\nPreview (first 2 KB):\n"));
    assert!(text.ends_with("\n...\n</persisted-output>"));
}

struct FullStore;

#[async_trait]
impl ArtifactStore for FullStore {
    async fn put(
        &self,
        _session: &SessionId,
        _purpose: ArtifactPurpose,
        _media_type: String,
        _bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError> {
        Err(StoreError::Storage {
            message: "disk full".to_owned(),
        })
    }

    async fn get(&self, _artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError> {
        Ok(Vec::new())
    }
}

async fn cut(text: String) -> String {
    let out = apply(
        output(&text),
        "LSP",
        Some(Limit::Bytes(100_000)),
        &SessionId::new("sess_1"),
        &FullStore,
    )
    .await;
    first(&out).to_owned()
}

/// Node `serializeToolResult` (`result-serialization.ts`): when a byte-budget result cannot be persisted, it is cut to
/// `maxModelBytes` with `fitContentWithSuffix` (head, whole code points) and the resultBudget suffix. The counts are
/// Node's own for these inputs.
#[tokio::test]
async fn a_byte_budget_result_that_cannot_be_persisted_is_cut_like_node() {
    let suffix = |bytes: usize| {
        format!(
            "\n\n[Tool output truncated by resultBudget: originalBytes={bytes}, maxModelBytes=100000, strategy=artifact]"
        )
    };
    let cjk = cut("語".repeat(40_000)).await;
    assert!(cjk == format!("{}{}", "語".repeat(33_298), suffix(120_000)));
    assert_eq!(cjk.len(), 99_998);
    let mixed = cut(format!("a{}", "語".repeat(40_000))).await;
    assert!(mixed == format!("a{}{}", "語".repeat(33_298), suffix(120_001)));
    // The character budget keeps its own fallback: the result whole.
    let whole = "a".repeat(60_000);
    let kept = apply(
        output(&whole),
        "Bash",
        Some(Limit::Chars(30_000)),
        &SessionId::new("sess_1"),
        &FullStore,
    )
    .await;
    assert!(first(&kept) == whole);
}
