//! Fork: the Network panel capture (specs/fork-rust-network-capture.md, acceptance cases 1–7).

use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader, duplex};

use super::*;

struct Harness {
    capture: Arc<NetworkCapture>,
    from_agent: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>,
    _scope: TaskScope,
}

fn harness(delay: Duration) -> Harness {
    let scope = TaskScope::root("test", |_| {});
    let (agent_out, host_in) = duplex(1 << 20);
    let (peer, _writer) = connection::start(agent_out, &scope.spawner(), Options::default());
    let capture = Arc::new(NetworkCapture::with_delay(
        peer,
        Arc::new(FixedClock(1_700_000_000_000)),
        scope.spawner(),
        4242,
        delay,
    ));
    Harness {
        capture,
        from_agent: BufReader::new(host_in).lines(),
        _scope: scope,
    }
}

impl Harness {
    async fn next(&mut self, within: Duration) -> Option<Value> {
        let line = tokio::time::timeout(within, self.from_agent.next_line())
            .await
            .ok()?
            .unwrap()?;
        Some(serde_json::from_str(&line).unwrap())
    }

    fn start(&self, id: &str) {
        assert!(self.capture.control(&json!({"captureId": id})));
    }
}

const SHORT: Duration = Duration::from_millis(20);

#[tokio::test]
async fn with_capture_off_nothing_is_recorded_or_sent() {
    let mut h = harness(SHORT);
    h.capture.record("GET", "https://example.com/a");
    assert!(h.next(Duration::from_millis(150)).await.is_none());
}

#[tokio::test]
async fn requests_are_batched_once_after_the_flush_delay() {
    let mut h = harness(FLUSH_DELAY);
    h.start("c1");
    let started = std::time::Instant::now();
    h.capture
        .record("POST", "https://api.example.com/v1/messages?beta=true");
    h.capture.record("GET", "http://example.com/");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert!(started.elapsed() >= FLUSH_DELAY);
    assert_eq!(batch["method"], json!("process/networkRequests"));
    assert_eq!(
        batch["params"],
        json!({
            "captureId": "c1",
            "records": [
                {"timestamp": 1_700_000_000_000_u64, "processType": "cli", "pid": 4242, "method": "POST",
                 "url": "https://api.example.com/v1/messages?beta=%5Bredacted%5D"},
                {"timestamp": 1_700_000_000_000_u64, "processType": "cli", "pid": 4242, "method": "GET",
                 "url": "http://example.com/"},
            ],
            "dropped": 0,
        })
    );
    // One batch per window.
    assert!(h.next(Duration::from_millis(400)).await.is_none());
}

#[tokio::test]
async fn a_window_keeps_one_hundred_records_and_counts_the_rest() {
    let mut h = harness(SHORT);
    h.start("c1");
    for index in 0..105 {
        h.capture
            .record("GET", &format!("https://example.com/{index}"));
    }
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["records"].as_array().unwrap().len(), 100);
    assert_eq!(batch["params"]["dropped"], json!(5));
    // The next window starts empty.
    h.capture.record("GET", "https://example.com/next");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["records"].as_array().unwrap().len(), 1);
    assert_eq!(batch["params"]["dropped"], json!(0));
}

#[tokio::test]
async fn connect_and_unsupported_urls_are_not_recorded_but_count_once_the_window_is_full() {
    let mut h = harness(SHORT);
    h.start("c1");
    h.capture.record("CONNECT", "https://proxy.example.com/");
    h.capture.record("GET", "ftp://example.com/file");
    h.capture.record("GET", "not a url");
    assert!(h.next(Duration::from_millis(150)).await.is_none());
    for index in 0..100 {
        h.capture
            .record("GET", &format!("https://example.com/{index}"));
    }
    // Node checks the window before the URL: a refused URL past the limit still counts as dropped.
    h.capture.record("GET", "ftp://example.com/late");
    h.capture.record("CONNECT", "https://proxy.example.com/");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["records"].as_array().unwrap().len(), 100);
    assert_eq!(batch["params"]["dropped"], json!(1));
}

#[test]
fn urls_are_sanitized_like_node() {
    let cases = [
        (
            "https://user:pass@example.com:8443/p/a%20b?token=abc#frag",
            Some("https://example.com:8443/p/a%20b?token=%5Bredacted%5D"),
        ),
        (
            "https://example.com/?a=1&b=2&a=3",
            Some("https://example.com/?a=%5Bredacted%5D&b=%5Bredacted%5D"),
        ),
        (
            "https://example.com/?flag",
            Some("https://example.com/?flag=%5Bredacted%5D"),
        ),
        (
            "https://example.com/?=x",
            Some("https://example.com/?=%5Bredacted%5D"),
        ),
        (
            "https://example.com/?a+b=1&c%2Bd=2",
            Some("https://example.com/?a+b=%5Bredacted%5D&c%2Bd=%5Bredacted%5D"),
        ),
        ("https://example.com/?", Some("https://example.com/?")),
        ("https://example.com/?&&", Some("https://example.com/?&&")),
        (
            "wss://example.com/socket?t=1",
            Some("wss://example.com/socket?t=%5Bredacted%5D"),
        ),
        ("HTTP://Example.COM", Some("http://example.com/")),
        ("ftp://example.com/", None),
        ("file:///etc/passwd", None),
        ("/relative", None),
    ];
    for (input, expected) in cases {
        assert_eq!(sanitize_url(input).as_deref(), expected, "{input}");
    }
    let long = format!("https://example.com/{}", "a".repeat(3_000));
    let sanitized = sanitize_url(&long).unwrap();
    assert_eq!(sanitized.len(), URL_LIMIT);
    assert!(long.starts_with(&sanitized));
}

#[test]
fn methods_are_cut_to_thirty_two_characters() {
    assert_eq!(method_name(&"X".repeat(40)).len(), 32);
    assert_eq!(method_name("GET"), "GET");
}

#[tokio::test]
async fn a_new_capture_id_drops_the_buffer_and_the_pending_flush() {
    let mut h = harness(Duration::from_millis(100));
    h.start("c1");
    h.capture.record("GET", "https://example.com/old");
    h.start("c2");
    h.capture.record("GET", "https://example.com/new");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["captureId"], json!("c2"));
    assert_eq!(
        batch["params"]["records"][0]["url"],
        json!("https://example.com/new")
    );
    assert_eq!(batch["params"]["records"].as_array().unwrap().len(), 1);
    assert!(h.next(Duration::from_millis(300)).await.is_none());

    h.capture.record("GET", "https://example.com/stopped");
    assert!(h.capture.control(&json!({"captureId": null})));
    assert!(h.next(Duration::from_millis(300)).await.is_none());
    h.capture.record("GET", "https://example.com/after-stop");
    assert!(h.next(Duration::from_millis(200)).await.is_none());
}

#[tokio::test]
async fn the_same_capture_id_keeps_the_buffer() {
    let mut h = harness(Duration::from_millis(100));
    h.start("c1");
    h.capture.record("GET", "https://example.com/1");
    h.start("c1");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["records"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn invalid_controls_are_ignored() {
    let mut h = harness(SHORT);
    h.start("c1");
    for invalid in [
        json!({"captureId": ""}),
        json!({"captureId": "x".repeat(101)}),
        json!({"captureId": "c2", "extra": true}),
        json!({"captureId": 7}),
        json!({}),
        json!(null),
        json!("c2"),
    ] {
        assert!(h.capture.control(&invalid), "{invalid}");
    }
    // A 100-character id is valid.
    assert!(NetworkCapture::parse(&json!({"captureId": "x".repeat(100)})).is_some());
    h.capture.record("GET", "https://example.com/");
    let batch = h.next(Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch["params"]["captureId"], json!("c1"));
}

#[tokio::test]
async fn the_wrapper_handles_only_the_capture_control_inline() {
    struct Inner;
    #[async_trait::async_trait]
    impl connection::Service for Inner {
        async fn request(
            &self,
            method: &str,
            _params: Value,
        ) -> Result<connection::Reply, rust_cli_protocol_core::rpc::RpcError> {
            Err(rust_cli_protocol_core::rpc::RpcError::method_not_found(
                method,
            ))
        }
    }
    let h = harness(SHORT);
    let service = with_network_capture(Arc::new(Inner), h.capture.clone());
    assert!(service.control(CONTROL, &json!({"captureId": "c1"})));
    assert!(!service.control("other", &json!({})));
    assert_eq!(h.capture.current().as_deref(), Some("c1"));
}
