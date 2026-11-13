use super::{document_uri, folder_uri, normalize, path_of};

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
    assert_eq!(path_of("file:///a%+2", false), None);
    assert_eq!(path_of("file:///a%2+", false), None);
    assert_eq!(normalize("file:///a%+2", false), "file:///a%+2");
}

/// Node `fileURLToPath` on Windows: the URL parser decodes and lowercases the host and rejects a forbidden one.
#[test]
fn a_unc_host_is_decoded_like_the_url_parser() {
    assert_eq!(
        path_of("file://ho%41st/share/x", true).as_deref(),
        Some("\\\\hoast\\share\\x")
    );
    assert_eq!(
        path_of("file://HOST/share/x", true).as_deref(),
        Some("\\\\host\\share\\x")
    );
    assert_eq!(path_of("file://ho%20st/share/x", true), None);
    assert_eq!(path_of("file://ho%zzst/share/x", true), None);
}
