use super::{UriError, document_uri, folder_uri, node_platform, normalize, path_of};

#[test]
fn documents_encode_like_path_to_file_url() {
    // Expected values come from Node 26 `pathToFileURL`.
    assert_eq!(
        document_uri("/w/a b#[x]~é.ts", false),
        "file:///w/a%20b%23%5Bx%5D%7E%C3%A9.ts"
    );
    assert_eq!(document_uri("/w/a@b(c)", false), "file:///w/a@b(c)");
    assert_eq!(document_uri("/w/a\\b", false), "file:///w/a%5Cb");
    assert_eq!(document_uri("C:\\a b\\x.ts", true), "file:///c:/a%20b/x.ts");
    assert_eq!(
        document_uri("\\\\srv\\share\\x", true),
        "file://srv/share/x"
    );
}

#[test]
fn folders_encode_each_segment_like_encode_uri_component() {
    assert_eq!(folder_uri("/w/a b@c(d)", false), "file:///w/a%20b%40c(d)");
    assert_eq!(folder_uri("C:\\Work\\a b", true), "file:///c:/Work/a%20b");
}

#[test]
fn server_uris_are_matched_after_decoding() {
    assert_eq!(normalize("file:///a%40b", false), "file:///a@b");
    assert_eq!(
        normalize("file:///a/%E2%9C%93", false),
        "file:///a/%E2%9C%93"
    );
    assert_eq!(
        normalize("file:///a/b%20c", false),
        document_uri("/a/b c", false)
    );
    // Not decodable: the spelling is kept.
    assert_eq!(normalize("file:///a%2Fb", false), "file:///a%2Fb");
    assert_eq!(normalize("file:///a%zz", false), "file:///a%zz");
    assert_eq!(normalize("file://host/a", false), "file://host/a");
    // A Windows drive colon may come encoded and in either case.
    assert_eq!(normalize("file:///C%3A/x/y", true), "file:///c:/x/y");
    assert_eq!(path_of("file:///c%3A/x/y%20z", true).unwrap(), "c:\\x\\y z");
}

/// Node `decodeURIComponent` accepts only two hex digits after `%`; a URI that does not decode keeps its spelling.
#[test]
fn a_signed_escape_does_not_decode() {
    assert_eq!(path_of("file:///a%+2", false), Err(malformed()));
    assert_eq!(path_of("file:///a%2+", false), Err(malformed()));
    assert_eq!(normalize("file:///a%+2", false), "file:///a%+2");
}

/// Node `fileURLToPath` on Windows: the URL parser decodes and lowercases the host and rejects a forbidden one.
#[test]
fn a_unc_host_is_decoded_like_the_url_parser() {
    assert_eq!(
        path_of("file://ho%41st/share/x", true).as_deref(),
        Ok("\\\\hoast\\share\\x")
    );
    assert_eq!(
        path_of("file://HOST/share/x", true).as_deref(),
        Ok("\\\\host\\share\\x")
    );
    assert_eq!(path_of("file://ho%20st/share/x", true), Err(invalid_url()));
    assert_eq!(path_of("file://ho%zzst/share/x", true), Err(invalid_url()));
}

fn error(code: &'static str, message: &str) -> UriError {
    UriError {
        code,
        message: message.to_owned(),
    }
}

fn malformed() -> UriError {
    error("URIError", "URI malformed")
}

fn invalid_url() -> UriError {
    error("ERR_INVALID_URL", "Invalid URL")
}

/// Node 26 `fileURLToPath` on darwin: the decoded path or the thrown error's `code` (`name` for a `URIError`) and
/// message.
#[test]
fn posix_paths_and_errors_match_node() {
    let scheme = error("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
    let host = error(
        "ERR_INVALID_FILE_URL_HOST",
        &format!(
            "File URL host must be \"localhost\" or empty on {}",
            node_platform()
        ),
    );
    let slash = error(
        "ERR_INVALID_FILE_URL_PATH",
        "File URL path must not include encoded / characters",
    );
    let cases: [(&str, Result<&str, UriError>); 24] = [
        ("file:///Z|/x", Ok("/Z:/x")),
        ("file:///a/Z|/x", Ok("/a/Z|/x")),
        ("file:///Z%7C/x", Ok("/Z|/x")),
        ("untitled:x", Err(scheme.clone())),
        ("http://x/a", Err(scheme)),
        ("file://host/a", Err(host.clone())),
        ("file://localhost/a%20b", Ok("/a b")),
        ("file:///a%2Fb", Err(slash.clone())),
        ("file:///a%2fb", Err(slash)),
        ("file:///a%5Cb", Ok("/a\\b")),
        ("file:///a%E0%A4%A", Err(malformed())),
        ("file:///a%00b", Ok("/a\u{0}b")),
        ("notaurl", Err(invalid_url())),
        ("file:///a%+2", Err(malformed())),
        ("file:///a%2+", Err(malformed())),
        // The host check comes first.
        ("file://host/a%2Fb", Err(host)),
        ("file:///a?q=1#f", Ok("/a")),
        ("FILE:///a", Ok("/a")),
        ("file:/a", Ok("/a")),
        ("file:a", Ok("/a")),
        ("file:///a%zz", Err(malformed())),
        ("file://LOCALHOST/x", Ok("/x")),
        ("file:///", Ok("/")),
        ("file:", Ok("/")),
    ];
    for (uri, expected) in cases {
        assert_eq!(path_of(uri, false), expected.map(str::to_owned), "{uri}");
    }
}

/// Node 26 `fileURLToPath(uri, {windows: true})`.
#[test]
fn windows_paths_and_errors_match_node() {
    let separator = error(
        "ERR_INVALID_FILE_URL_PATH",
        "File URL path must not include encoded \\ or / characters",
    );
    let relative = error(
        "ERR_INVALID_FILE_URL_PATH",
        "File URL path must be absolute",
    );
    let cases: [(&str, Result<&str, UriError>); 18] = [
        // Node `domainToUnicode` on the UNC host.
        ("file://xn--mnchen-3ya/x", Ok("\\\\m\u{fc}nchen\\x")),
        ("file://M\u{dc}NCHEN.de/x", Ok("\\\\m\u{fc}nchen.de\\x")),
        // Kept difference (spec): the `url` crate rejects a punycode label that does not decode; Node 26 gives
        // `\\xn--a.com\x`.
        ("file://xn--a.com/x", Err(invalid_url())),
        ("file:///C:/a%5Cb", Err(separator.clone())),
        ("file:///C:/a%2Fb", Err(separator)),
        ("file:///a", Err(relative)),
        ("file://host/share/x", Ok("\\\\host\\share\\x")),
        ("file:///c%3A/x", Ok("c:\\x")),
        ("file://ho%41st/share/x", Ok("\\\\hoast\\share\\x")),
        ("file://ho%20st/share/x", Err(invalid_url())),
        ("file:///C:/a%E0%A4%A", Err(malformed())),
        (
            "untitled:x",
            Err(error(
                "ERR_INVALID_URL_SCHEME",
                "The URL must be of scheme file",
            )),
        ),
        ("notaurl", Err(invalid_url())),
        ("file://localhost/C:/x", Ok("C:\\x")),
        ("file:///C:", Ok("C:")),
        ("file:///C:/", Ok("C:\\")),
        ("file:///Z|/x", Ok("Z:\\x")),
        ("file:///C:/a%zz", Err(malformed())),
    ];
    for (uri, expected) in cases {
        assert_eq!(path_of(uri, true), expected.map(str::to_owned), "{uri}");
    }
}

/// Node `pathToFileURL` encodes every C0 control and DEL, and keeps `@` and `:` raw (Node 26 output).
#[test]
fn documents_encode_every_control_like_node() {
    let controls: String = (0u8..0x20).map(char::from).collect();
    assert_eq!(
        document_uri(&format!("/a{controls}\u{7f} b"), false),
        "file:///a%00%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F%7F%20b"
    );
    assert_eq!(
        document_uri("/x/a b/é/b@c/%/#?/\\:", false),
        "file:///x/a%20b/%C3%A9/b@c/%25/%23%3F/%5C:"
    );
    assert_eq!(
        document_uri("C:\\a b\\%x\\é\\b@c", true),
        "file:///c:/a%20b/%25x/%C3%A9/b@c"
    );
}

#[test]
fn the_platform_name_is_node_process_platform() {
    let expected = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    assert_eq!(node_platform(), expected);
}
