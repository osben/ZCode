use super::*;

fn gbk(text: &str) -> Vec<u8> {
    GBK.encode(text).0.into_owned()
}

#[test]
fn encodings_are_detected_in_nodes_order() {
    assert_eq!(detect(b"\xef\xbb\xbfplain"), Some(UTF_8));
    // A UTF-16LE BOM wins over the NUL bytes that would make it binary.
    assert_eq!(detect(b"\xff\xfea\x00b\x00"), Some(UTF_16LE));
    assert_eq!(detect(b"a\x00b"), None);
    assert_eq!(detect(b"\x01\x02\x03a"), None);
    assert_eq!(detect("中文 text".as_bytes()), Some(UTF_8));
    assert_eq!(detect(&gbk("中文 text")), Some(GBK));
    // A GBK file cut inside a two-byte character still round-trips once the cut byte is dropped.
    let mut cut = gbk("中文");
    cut.push(0xd6);
    assert_eq!(detect(&cut), Some(GBK));
    // Four-byte GB18030 sequences have no GBK form.
    let gb18030 = GB18030.encode("中😀").0.into_owned();
    assert_eq!(detect(&gb18030), Some(GB18030));
    assert_eq!(detect(b"\x81"), None);
}

#[test]
fn a_cut_utf8_sequence_is_completed_only_as_far_as_needed() {
    assert_eq!(utf8_completion_bytes(b"ab"), 0);
    assert_eq!(utf8_completion_bytes(&[b'a', 0xe4]), 2);
    assert_eq!(utf8_completion_bytes(&[b'a', 0xe4, 0xb8]), 1);
    assert_eq!(utf8_completion_bytes("中".as_bytes()), 0);
    assert_eq!(utf8_completion_bytes(&[0xd6]), 1);
    assert_eq!(utf8_completion_bytes(&[]), 0);
}

#[test]
fn tokens_are_estimated_like_node() {
    assert_eq!(estimate_tokens(""), 0);
    assert_eq!(estimate_tokens("abcd"), 2);
    // Two CJK ideographs count four, the emoji two UTF-16 units.
    assert_eq!(estimate_tokens("中文😀"), 2);
}

#[test]
fn lines_count_the_whole_file_and_keep_the_first() {
    let range = decode_whole(b"a\r\nb\nc\n", UTF_8, Some(2));
    assert_eq!(range.content, "a\nb");
    assert_eq!(range.total_lines, 4);
    let empty = decode_whole(b"", UTF_8, None);
    assert_eq!((empty.content.as_str(), empty.total_lines), ("", 0));
    // The fast path keeps a lone `\r` at the end; the BOM is kept.
    let range = decode_whole(b"\xef\xbb\xbfa\r", UTF_8, None);
    assert_eq!(range.content, "\u{feff}a\r");
}

async fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
    let path = dir.path().join(name);
    rust_cli_fs::append(&path, bytes).await.unwrap();
    path.to_string_lossy().into_owned()
}

fn read_of(body: &AttachedBody) -> (&str, &TextRead) {
    match body {
        AttachedBody::Text {
            text,
            read: Some(read),
        } => (text, read),
        other => panic!("not a read text: {other:?}"),
    }
}

#[tokio::test]
async fn a_small_file_is_sent_whole() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(&dir, "a.txt", b"one\ntwo\n").await;
    let body = local_text(&path).await;
    let (text, read) = read_of(&body);
    assert_eq!(text, "one\ntwo\n");
    assert_eq!(
        *read,
        TextRead {
            path: path.clone(),
            start_line: 1,
            total_lines: 3,
            original_bytes: 8,
            truncated: false,
            truncated_by_token_cap: false,
            notice: None,
        }
    );
}

#[tokio::test]
async fn a_file_over_256_kib_sends_its_first_2000_lines_unmarked() {
    let dir = tempfile::tempdir().unwrap();
    let content: String = (1..=30_000).map(|n| format!("line {n:>24}\n")).collect();
    let path = write(&dir, "big.log", content.as_bytes()).await;
    let body = local_text(&path).await;
    let (text, read) = read_of(&body);
    assert_eq!(text.lines().count(), 2000);
    assert!(text.ends_with("line                     2000"));
    assert_eq!(read.total_lines, 30_001);
    assert_eq!(read.original_bytes, content.len() as u64);
    assert!(!read.truncated && read.notice.is_none());
}

#[tokio::test]
async fn over_the_token_cap_a_partial_view_is_sent_with_nodes_notice() {
    let dir = tempfile::tempdir().unwrap();
    // 2000 lines of 60 CJK ideographs: 80 tokens a line, far over the cap.
    let line = "中".repeat(60);
    let content: String = (0..3000).map(|_| format!("{line}\n")).collect();
    let path = write(&dir, "zh.txt", content.as_bytes()).await;
    let body = local_text(&path).await;
    let (text, read) = read_of(&body);
    let shown = text.split('\n').count() as u64;
    assert!(estimate_tokens(text) <= READ_MAX_OUTPUT_TOKENS);
    assert!(read.truncated && read.truncated_by_token_cap);
    let tokens = estimate_tokens(&vec![line.as_str(); 2000].join("\n"));
    assert_eq!(
        read.notice.as_deref(),
        Some(
            format!(
                "[Truncated: PARTIAL view \u{2014} {path}: showing lines 1-{shown} of 3001 total ({tokens} tokens, cap 25000). Call Read with offset={} limit={shown} for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]",
                shown + 1
            )
            .as_str()
        )
    );
}

#[tokio::test]
async fn a_long_single_line_falls_back_to_a_character_slice() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(&dir, "one.txt", "x".repeat(200_000).as_bytes()).await;
    let body = local_text(&path).await;
    let (text, read) = read_of(&body);
    assert!(text.len() < 200_000 && estimate_tokens(text) <= READ_MAX_OUTPUT_TOKENS);
    let notice = read.notice.as_deref().unwrap();
    assert!(notice.contains(&format!(
        "showing the first {} of 200000 characters",
        text.len()
    )));
}

#[tokio::test]
async fn a_large_gbk_file_is_detected_across_the_sample_edge() {
    let dir = tempfile::tempdir().unwrap();
    // Node's E2E layout: the sample's last byte (4095) is the first byte of `中` in GBK (D6 D0), so a sample cut there
    // looks like a UTF-8 lead byte. 11 MiB takes the streaming path.
    let mut bytes = vec![b'a'; 4095];
    bytes.extend(gbk("中文 marker\n"));
    let line = gbk("第二行内容\n");
    while bytes.len() < 11 * 1024 * 1024 {
        bytes.extend(&line);
    }
    let path = write(&dir, "gbk.txt", &bytes).await;
    let body = local_text(&path).await;
    let (text, read) = read_of(&body);
    assert!(text.contains("中文 marker"));
    assert!(!text.contains('\u{fffd}'));
    assert_eq!(text.split('\n').count(), 2000);
    assert!(read.total_lines > 2000);
}

#[tokio::test]
async fn a_large_utf8_file_cut_at_the_sample_edge_stays_utf8() {
    let dir = tempfile::tempdir().unwrap();
    // `中` (3 bytes) straddles byte 4096.
    let mut bytes = vec![b'a'; 4095];
    bytes.extend("中文 marker\n".as_bytes());
    while bytes.len() < 11 * 1024 * 1024 {
        bytes.extend("第二行内容\n".as_bytes());
    }
    let path = write(&dir, "utf8.txt", &bytes).await;
    let body = local_text(&path).await;
    let (text, _) = read_of(&body);
    assert!(text.contains("中文 marker"));
    assert!(!text.contains('\u{fffd}'));
}

#[tokio::test]
async fn an_unreadable_file_is_nodes_failed_placeholder() {
    let dir = tempfile::tempdir().unwrap();
    let binary = write(&dir, "bin.txt", b"a\x00b").await;
    assert_eq!(local_text(&binary).await, AttachedBody::ReadFailed);
    let missing = dir.path().join("missing.txt");
    assert_eq!(
        local_text(&missing.to_string_lossy()).await,
        AttachedBody::ReadFailed
    );
    assert_eq!(
        local_text(&dir.path().to_string_lossy()).await,
        AttachedBody::ReadFailed
    );
}
