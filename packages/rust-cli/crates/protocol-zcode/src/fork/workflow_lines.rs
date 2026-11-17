//! Fork: the NDJSON line reader of a sandbox child's stdout (specs/fork-rust-workflow-engine.md, 4.1).
//!
//! The state lives here: the bytes of a line that has not ended yet stay in `line`, and a read consumes them only once
//! they are copied in. So [`NdjsonLines::next`] is safe to drop inside a `select!` and resume later, as
//! `acp::rpc::StderrLines` is. A line over [`MAX_LINE_BYTES`] is not buffered: the caller stops the run.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// The longest line the host accepts, in bytes. A model-authored script can make a large report, so the cap is generous,
/// but it is a cap: one runaway line cannot grow the engine's memory without limit.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// What one read produced.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// One line, without its newline. A last line with no newline at the end of the stream is also a line.
    Text(Vec<u8>),
    /// The line is longer than [`MAX_LINE_BYTES`]; the rest of it is not read.
    TooLong,
    /// The end of the stream, with no partial line pending.
    End,
}

/// The child's stdout as NDJSON lines.
pub struct NdjsonLines<R> {
    reader: R,
    line: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> NdjsonLines<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            line: Vec::new(),
        }
    }

    /// The next line. Cancel-safe: a dropped call leaves the bytes read so far in `line`.
    pub async fn next(&mut self) -> io::Result<Line> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(if self.line.is_empty() {
                    Line::End
                } else {
                    Line::Text(std::mem::take(&mut self.line))
                });
            }
            let (chunk, newline) = match available.iter().position(|byte| *byte == b'\n') {
                Some(position) => (&available[..position], true),
                None => (available, false),
            };
            if self.line.len() + chunk.len() > MAX_LINE_BYTES {
                self.line.clear();
                return Ok(Line::TooLong);
            }
            self.line.extend_from_slice(chunk);
            let used = chunk.len() + usize::from(newline);
            self.reader.consume(used);
            if newline {
                return Ok(Line::Text(std::mem::take(&mut self.line)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader, duplex};

    #[tokio::test]
    async fn a_line_split_by_a_dropped_read_is_read_whole() {
        let (mut writer, reader) = duplex(64);
        let mut lines = NdjsonLines::new(BufReader::with_capacity(8, reader));
        writer.write_all(b"abc").await.unwrap();
        // The read is dropped while the line is still open, as a select! branch that lost the race is.
        let dropped =
            tokio::time::timeout(std::time::Duration::from_millis(30), lines.next()).await;
        assert!(dropped.is_err(), "the line has no newline yet");
        writer.write_all(b"def\n").await.unwrap();
        assert_eq!(lines.next().await.unwrap(), Line::Text(b"abcdef".to_vec()));
    }

    #[tokio::test]
    async fn a_pending_partial_line_at_the_end_of_the_stream_is_a_line() {
        let (mut writer, reader) = duplex(64);
        let mut lines = NdjsonLines::new(BufReader::new(reader));
        writer.write_all(b"tail").await.unwrap();
        drop(writer);
        assert_eq!(lines.next().await.unwrap(), Line::Text(b"tail".to_vec()));
        assert_eq!(lines.next().await.unwrap(), Line::End);
    }

    #[tokio::test]
    async fn a_line_over_the_cap_is_refused_before_it_is_buffered() {
        let (mut writer, reader) = duplex(1 << 16);
        let mut lines = NdjsonLines::new(BufReader::new(reader));
        tokio::spawn(async move {
            let block = vec![b'x'; 1 << 16];
            let mut sent = 0;
            while sent <= MAX_LINE_BYTES {
                if writer.write_all(&block).await.is_err() {
                    return;
                }
                sent += block.len();
            }
        });
        assert_eq!(lines.next().await.unwrap(), Line::TooLong);
    }
}
