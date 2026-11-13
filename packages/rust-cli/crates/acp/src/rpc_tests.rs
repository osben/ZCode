use super::{STDERR_LINE_BYTES, StderrLines};

#[tokio::test]
async fn a_stderr_line_is_capped_and_the_rest_of_it_dropped() {
    let mut input = b"first\n".to_vec();
    input.extend(std::iter::repeat_n(b'x', STDERR_LINE_BYTES * 8));
    input.extend_from_slice(b"\nlast");
    let mut lines = StderrLines::new(input.as_slice());
    assert_eq!(lines.next().await.as_deref(), Some("first"));
    let long = lines.next().await.expect("the long line");
    assert!(
        long.len() <= STDERR_LINE_BYTES + "… [truncated]".len(),
        "{}",
        long.len()
    );
    assert!(long.ends_with("… [truncated]"));
    assert_eq!(lines.next().await.as_deref(), Some("last"));
    assert_eq!(lines.next().await, None);
}
