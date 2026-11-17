//! Loopback listener tests (`specs/fork-rust-mcp-oauth.md`, PR2 acceptance 7): the callback
//! listener binds loopback only, reads the request target, answers once, and refuses oversized lines.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::LoopbackListener;

#[tokio::test]
async fn binds_loopback_on_an_ephemeral_port() {
    let listener = LoopbackListener::bind_ephemeral().await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    assert!(addr.ip().is_loopback());
    assert_eq!(addr.ip().to_string(), "127.0.0.1");
    assert_ne!(addr.port(), 0);
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "net is the socket entry crate: the test dials its own loopback listener"
)]
async fn reads_the_target_and_answers_once_then_closes() {
    let listener = LoopbackListener::bind_ephemeral().await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let client = tokio::spawn(async move {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream
            .write_all(b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .expect("write");
        let mut response = String::new();
        stream.read_to_string(&mut response).await.expect("read");
        response
    });
    let mut connection = listener.accept().await.expect("accept");
    assert_eq!(
        connection.request_target().await.expect("target"),
        "/callback?code=c&state=s"
    );
    connection.respond(200, "done").await.expect("respond");
    let response = client.await.expect("client");
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(response.contains("Connection: close"));
    assert!(response.ends_with("done"));
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "net is the socket entry crate: the test dials its own loopback listener"
)]
async fn an_oversized_request_line_is_refused() {
    let listener = LoopbackListener::bind_ephemeral().await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let client = tokio::spawn(async move {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        let mut line = b"GET /".to_vec();
        line.extend(std::iter::repeat_n(b'a', 16 * 1024));
        line.extend_from_slice(b" HTTP/1.1\r\n\r\n");
        let _ = stream.write_all(&line).await;
    });
    let mut connection = listener.accept().await.expect("accept");
    assert!(connection.request_target().await.is_err());
    let _ = client.await;
}

#[tokio::test]
async fn each_flow_gets_its_own_port() {
    let first = LoopbackListener::bind_ephemeral().await.expect("bind");
    let second = LoopbackListener::bind_ephemeral().await.expect("bind");
    assert_ne!(
        first.local_addr().expect("addr").port(),
        second.local_addr().expect("addr").port()
    );
}
