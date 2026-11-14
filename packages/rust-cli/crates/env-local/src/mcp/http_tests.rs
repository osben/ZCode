//! HTTP 传输的请求构造（ext.md §3.2）。

use super::*;

/// 缺陷 R2-13：配置给的 header（常是 Authorization）原来按普通值交给 net；现在是秘密值，Debug 里看不到。
#[test]
fn configured_headers_are_secret() {
    let headers = BTreeMap::from([("authorization".to_owned(), "Bearer t0k-secret".to_owned())]);
    let shown = format!(
        "{:?}",
        with_headers(HttpRequest::get("http://h/sse"), &headers)
    );
    assert!(shown.contains("authorization"), "{shown}");
    assert!(!shown.contains("t0k-secret"), "{shown}");
}

/// Fork: MCP traffic stays out of the Network panel, like Node's `withoutNetworkCapture`
/// (specs/fork-rust-network-capture.md, case 8). Every MCP request is built through `with_headers`.
#[test]
fn mcp_requests_are_not_observed() {
    let none = BTreeMap::new();
    assert!(!with_headers(HttpRequest::get("http://h/sse"), &none).observed);
    let some = BTreeMap::from([("x-a".to_owned(), "b".to_owned())]);
    assert!(!with_headers(HttpRequest::post("http://h/mcp", "{}"), &some).observed);
    assert!(HttpRequest::get("http://h/other").observed);
}
