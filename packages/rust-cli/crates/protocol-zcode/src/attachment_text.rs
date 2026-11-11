//! Fork: a desktop text attachment read the way Node's `resolveLocalFileAttachment` reads it (`readTextFileForModel`,
//! the fs adapter's `readTextFileRange` and `text-metadata.ts`): encoding detection with GBK / GB18030, the first 2000
//! lines of a file over 256 KiB, and the 25,000-token partial view (specs/fork-agent-runtime-selection.md, "Local text
//! files").

use std::path::Path;

use encoding_rs::{Encoding, GB18030, GBK, UTF_8, UTF_16LE};
use rust_cli_base::js::string::{trim, utf16_len, utf16_prefix};
use rust_cli_kernel_api::message::{AttachedBody, TextRead};
use tokio::io::AsyncReadExt;

/// Node `READ_MAX_FILE_SIZE_BYTES`: a larger file sends only its first [`READ_DEFAULT_MAX_LINES`] lines.
const READ_MAX_FILE_SIZE_BYTES: u64 = 256 * 1024;
/// Node `READ_DEFAULT_MAX_LINES`.
const READ_DEFAULT_MAX_LINES: usize = 2000;
/// Node `READ_MAX_OUTPUT_TOKENS`.
const READ_MAX_OUTPUT_TOKENS: u64 = 25_000;
/// Node `FAST_PATH_MAX_BYTES`: a file up to this size is detected on all its bytes.
const FAST_PATH_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Node `ENCODING_SAMPLE_BYTES`: the head a larger file is detected on.
const ENCODING_SAMPLE_BYTES: usize = 4096;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const PARTIAL_VIEW_FIT_RATIO: f64 = 0.85;
const PARTIAL_VIEW_SHRINK_RATIO: f64 = 0.7;
const PARTIAL_VIEW_SHRINK_STEPS: usize = 6;
const BINARY_CONTROL_BYTE_THRESHOLD: f64 = 0.3;
const MAX_DETECTION_TRAILING_DROP_BYTES: usize = 3;

/// Node `detectTextEncoding`: `None` is Node's "Unsupported or binary text encoding". The BOMs are checked before the
/// binary test (UTF-16 holds NUL bytes).
pub(crate) fn detect(buffer: &[u8]) -> Option<&'static Encoding> {
    if buffer.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Some(UTF_8);
    }
    if buffer.starts_with(&[0xff, 0xfe]) {
        return Some(UTF_16LE);
    }
    if looks_like_binary(buffer) {
        return None;
    }
    if std::str::from_utf8(buffer).is_ok() {
        return Some(UTF_8);
    }
    // Node tries gb2312, gbk, gb18030 (iconv-lite); in encoding_rs gb2312 is a label of GBK.
    [GBK, GB18030]
        .into_iter()
        .find(|encoding| round_trips(buffer, encoding))
}

fn looks_like_binary(buffer: &[u8]) -> bool {
    if buffer.is_empty() {
        return false;
    }
    let mut control = 0usize;
    for &byte in buffer {
        if byte == 0 {
            return true;
        }
        if byte < 0x09 || (byte > 0x0d && byte < 0x20) {
            control += 1;
        }
    }
    control as f64 / buffer.len() as f64 > BINARY_CONTROL_BYTE_THRESHOLD
}

/// Node `roundTripsWithOptionalTrailingDrop`: the bytes, less up to 3 trailing ones (a cut multi-byte character),
/// decode and encode back to themselves. encoding_rs encodes an unmappable character as `&#…;`, so that is a failure
/// too.
fn round_trips(buffer: &[u8], encoding: &'static Encoding) -> bool {
    (0..=MAX_DETECTION_TRAILING_DROP_BYTES.min(buffer.len())).any(|drop| {
        let candidate = &buffer[..buffer.len() - drop];
        if candidate.is_empty() {
            return false;
        }
        let (decoded, malformed) = encoding.decode_without_bom_handling(candidate);
        if malformed {
            return false;
        }
        let (encoded, _, unmappable) = encoding.encode(&decoded);
        !unmappable && encoded.as_ref() == candidate
    })
}

/// Node `getUtf8CompletionBytes`: the bytes a UTF-8 sequence cut at the end of `buffer` still lacks.
fn utf8_completion_bytes(buffer: &[u8]) -> usize {
    let Some(mut start) = buffer.len().checked_sub(1) else {
        return 0;
    };
    let earliest = buffer.len().saturating_sub(4);
    while start > earliest && buffer[start] & 0xc0 == 0x80 {
        start -= 1;
    }
    let lead = buffer[start];
    let length: usize = match lead {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    };
    length.saturating_sub(buffer.len() - start)
}

/// Node's estimate (`context/utils.ts` `estimateTokens`): a CJK ideograph (U+4E00–U+9FFF) counts twice, everything
/// else once per UTF-16 unit, three per token.
fn estimate_tokens(text: &str) -> u64 {
    let cjk = text
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count() as u64;
    let other = utf16_len(text) as u64 - cjk;
    (cjk * 2 + other).div_ceil(3)
}

/// The lines of a decoded file, collected as Node's adapter does: every line is counted, the first `limit` are kept.
struct Lines {
    limit: Option<usize>,
    /// The streaming path strips one `\r` from every line, the last one included; the fast path replaces `\r\n`, so a
    /// lone `\r` at the end of the file stays.
    streaming: bool,
    kept: Vec<String>,
    carry: String,
    total: u64,
}

impl Lines {
    fn new(limit: Option<usize>, streaming: bool) -> Self {
        Lines {
            limit,
            streaming,
            kept: Vec::new(),
            carry: String::new(),
            total: 0,
        }
    }

    fn line(&mut self, line: &str, strip: bool) {
        if self.limit.is_none_or(|limit| self.kept.len() < limit) {
            let line = if strip {
                line.strip_suffix('\r').unwrap_or(line)
            } else {
                line
            };
            self.kept.push(line.to_owned());
        }
        self.total += 1;
    }

    fn push(&mut self, text: &str) {
        self.carry.push_str(text);
        let carry = std::mem::take(&mut self.carry);
        let mut rest = carry.as_str();
        while let Some(at) = rest.find('\n') {
            self.line(&rest[..at], true);
            rest = &rest[at + 1..];
        }
        self.carry = rest.to_owned();
    }

    /// `any` is whether the file had any bytes (Node pushes the last line only then).
    fn finish(mut self, any: bool) -> (String, u64) {
        if any {
            let last = std::mem::take(&mut self.carry);
            self.line(&last, self.streaming);
        }
        (self.kept.join("\n"), self.total)
    }
}

/// What was read of a text file, before the token cap.
struct Range {
    content: String,
    total_lines: u64,
}

fn decode_whole(buffer: &[u8], encoding: &'static Encoding, limit: Option<usize>) -> Range {
    let (decoded, _) = encoding.decode_without_bom_handling(buffer);
    let mut lines = Lines::new(limit, false);
    lines.push(&decoded);
    let (content, total_lines) = lines.finish(!buffer.is_empty());
    Range {
        content,
        total_lines,
    }
}

/// Node `detectEncodingFromHead`: the first 4096 bytes, extended only to complete a UTF-8 sequence cut at the end (a
/// fixed larger sample could cut the next character).
async fn detect_from_head(
    file: &mut tokio::fs::File,
) -> std::io::Result<Option<&'static Encoding>> {
    let mut sample = vec![0u8; ENCODING_SAMPLE_BYTES];
    let mut read = 0;
    while read < sample.len() {
        let n = file.read(&mut sample[read..]).await?;
        if n == 0 {
            break;
        }
        read += n;
        if read == ENCODING_SAMPLE_BYTES {
            let missing = utf8_completion_bytes(&sample);
            sample.resize(ENCODING_SAMPLE_BYTES + missing, 0);
        }
    }
    Ok(detect(&sample[..read]))
}

/// Node `readRangeStreaming`: the file decoded chunk by chunk, every line counted.
async fn read_streaming(path: &Path, limit: Option<usize>) -> std::io::Result<Option<Range>> {
    let mut file = rust_cli_fs::open_read(path).await?;
    let Some(encoding) = detect_from_head(&mut file).await? else {
        return Ok(None);
    };
    let mut file = rust_cli_fs::open_read(path).await?;
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut lines = Lines::new(limit, true);
    let mut chunk = vec![0u8; STREAM_CHUNK_BYTES];
    let mut any = false;
    loop {
        let n = file.read(&mut chunk).await?;
        let last = n == 0;
        any |= n > 0;
        let mut text =
            String::with_capacity(decoder.max_utf8_buffer_length(n).unwrap_or(n * 3 + 16));
        let _ = decoder.decode_to_string(&chunk[..n], &mut text, last);
        lines.push(&text);
        if last {
            break;
        }
    }
    let (content, total_lines) = lines.finish(any);
    Ok(Some(Range {
        content,
        total_lines,
    }))
}

/// Node `readTextFileRange` for an attachment: `None` is an unsupported encoding.
async fn read_range(
    path: &Path,
    size: u64,
    limit: Option<usize>,
) -> std::io::Result<Option<Range>> {
    if size <= FAST_PATH_MAX_BYTES {
        return Ok(
            match rust_cli_fs::read_regular_bounded(path, FAST_PATH_MAX_BYTES).await? {
                // Detecting GBK encodes the whole buffer back (up to 10 MiB, as Node does): off the async workers.
                rust_cli_fs::BoundedRead::Bytes(buffer) => tokio::task::spawn_blocking(move || {
                    detect(&buffer).map(|encoding| decode_whole(&buffer, encoding, limit))
                })
                .await
                .map_err(std::io::Error::other)?,
                // The file grew past the fast path or changed kind since the stat.
                _ => None,
            },
        );
    }
    read_streaming(path, limit).await
}

/// Node `createTokenCapPartialView`: `None` when even the character slice does not fit.
fn partial_view(
    content: &str,
    tokens: u64,
    total_lines: u64,
    path: &str,
) -> Option<(String, TextRead)> {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let content_units = utf16_len(content);
    let chars_per_token = (content_units as f64 / tokens as f64).max(0.5);
    let cap = READ_MAX_OUTPUT_TOKENS as f64;
    let fits = |text: &str| estimate_tokens(text) <= READ_MAX_OUTPUT_TOKENS;
    let mut count = ((lines.len() as f64 * cap / tokens as f64) * PARTIAL_VIEW_FIT_RATIO)
        .floor()
        .min(lines.len() as f64)
        .max(1.0) as usize;
    let mut view = lines[..count].join("\n");
    for _ in 0..PARTIAL_VIEW_SHRINK_STEPS {
        if fits(&view) || count <= 1 {
            break;
        }
        count = ((count as f64 * PARTIAL_VIEW_SHRINK_RATIO).floor() as usize).max(1);
        view = lines[..count].join("\n");
    }
    let mut by_characters = false;
    if !fits(&view) || trim(&view).is_empty() {
        let mut units = ((cap * chars_per_token * PARTIAL_VIEW_FIT_RATIO).floor() as usize).max(1);
        for _ in 0..PARTIAL_VIEW_SHRINK_STEPS {
            // JS `slice` then `dropTrailingHighSurrogate`: a cut surrogate pair is dropped whole.
            view = utf16_prefix(content, units).to_owned();
            if fits(&view) {
                break;
            }
            units = ((units as f64 * PARTIAL_VIEW_SHRINK_RATIO).floor() as usize).max(1);
        }
        if !fits(&view) {
            return None;
        }
        by_characters = true;
    }
    let shown = if by_characters {
        view.split('\n').count() as u64
    } else {
        count as u64
    };
    let last = shown;
    let budget = format!("{tokens} tokens, cap {READ_MAX_OUTPUT_TOKENS}");
    let notice = if !by_characters && last < total_lines {
        format!(
            "[Truncated: PARTIAL view \u{2014} {path}: showing lines 1-{last} of {total_lines} total ({budget}). Call Read with offset={} limit={shown} for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]",
            last + 1
        )
    } else {
        format!(
            "[Truncated: PARTIAL view \u{2014} {path}: showing the first {} of {content_units} characters ({budget}); this file has very long lines and cannot be paginated by line. Use Grep to find a specific section, or Read with offset/limit to page through it. Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]",
            utf16_len(&view)
        )
    };
    Some((
        view,
        TextRead {
            path: path.to_owned(),
            start_line: 1,
            total_lines,
            original_bytes: 0,
            truncated: true,
            truncated_by_token_cap: true,
            notice: Some(notice),
        },
    ))
}

/// The body of a desktop text file (an absolute local path that is not text material, not media and not taken as a
/// path reference). Any failure is Node's `attachment_read_failed` placeholder; the log names only the fault.
pub(crate) async fn local_text(path: &str) -> AttachedBody {
    match read_text(path).await {
        Ok(Some(body)) => body,
        Ok(None) => {
            tracing::warn!(
                event = "attachment.read_failed",
                fault = "unsupported",
                "a text attachment could not be read"
            );
            AttachedBody::ReadFailed
        }
        Err(error) => {
            tracing::warn!(event = "attachment.read_failed", fault = %error.kind(), "a text attachment could not be read");
            AttachedBody::ReadFailed
        }
    }
}

async fn read_text(path: &str) -> std::io::Result<Option<AttachedBody>> {
    let Some(stat) = rust_cli_fs::stat(Path::new(path)).await? else {
        return Ok(None);
    };
    if !stat.is_file {
        return Ok(None);
    }
    let limit = (stat.len > READ_MAX_FILE_SIZE_BYTES).then_some(READ_DEFAULT_MAX_LINES);
    let Some(range) = read_range(Path::new(path), stat.len, limit).await? else {
        return Ok(None);
    };
    let tokens = estimate_tokens(&range.content);
    let (text, mut read) = if tokens > READ_MAX_OUTPUT_TOKENS {
        let Some(view) = partial_view(&range.content, tokens, range.total_lines, path) else {
            return Ok(None);
        };
        view
    } else {
        (
            range.content,
            TextRead {
                path: path.to_owned(),
                start_line: 1,
                total_lines: range.total_lines,
                original_bytes: 0,
                truncated: false,
                truncated_by_token_cap: false,
                notice: None,
            },
        )
    };
    read.original_bytes = stat.len;
    Ok(Some(AttachedBody::Text {
        text,
        read: Some(Box::new(read)),
    }))
}

#[cfg(test)]
#[path = "attachment_text_tests.rs"]
mod tests;
