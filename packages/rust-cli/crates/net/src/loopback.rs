//! Loopback listener for the MCP OAuth callback (Node `apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts`).
//!
//! Only `127.0.0.1` on an ephemeral port is bound, so the redirect URI is `http://127.0.0.1:<port>/…` and the
//! listener is never reachable from another host. The request handling is deliberately minimal: read the
//! request line, answer once, close. The caller decides whether the target is the authorization response.

use std::io;
use std::net::SocketAddr;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// A request line longer than this is refused, so a local client cannot grow the buffer without bound.
const MAX_REQUEST_LINE: usize = 8 * 1024;

/// A bound loopback listener on `127.0.0.1:<ephemeral>`.
#[derive(Debug)]
pub struct LoopbackListener {
    inner: TcpListener,
}

impl LoopbackListener {
    /// Bind `127.0.0.1:0`. Every flow binds a new port (Node: no reuse, the listener lives for the whole wait).
    #[expect(
        clippy::disallowed_methods,
        reason = "net is the listener entry crate (README §4): the OAuth callback listens on loopback here"
    )]
    pub async fn bind_ephemeral() -> io::Result<Self> {
        let inner = TcpListener::bind(("127.0.0.1", 0)).await?;
        Ok(Self { inner })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }

    /// The next connection. The caller reads its request target and answers it.
    pub async fn accept(&self) -> io::Result<LoopbackConnection> {
        let (stream, _) = self.inner.accept().await?;
        Ok(LoopbackConnection {
            reader: BufReader::new(stream),
        })
    }
}

/// One accepted connection. Dropping it closes the socket.
#[derive(Debug)]
pub struct LoopbackConnection {
    reader: BufReader<TcpStream>,
}

impl LoopbackConnection {
    /// The request target of the first line (`GET /callback?code=…&state=… HTTP/1.1` gives `/callback?code=…&state=…`).
    pub async fn request_target(&mut self) -> io::Result<String> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).await?;
        if read == 0 || !line.ends_with('\n') || line.len() > MAX_REQUEST_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "callback request line is too long or incomplete",
            ));
        }
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some(_method), Some(target)) => Ok(target.to_owned()),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "callback request has no target",
            )),
        }
    }

    /// Write a complete HTTP/1.1 response with `Connection: close`, then shut the socket down.
    pub async fn respond(&mut self, status: u16, body: &str) -> io::Result<()> {
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            _ => "Response",
        };
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let stream = self.reader.get_mut();
        stream.write_all(response.as_bytes()).await?;
        stream.shutdown().await
    }
}

#[cfg(test)]
#[path = "loopback_tests.rs"]
mod tests;
