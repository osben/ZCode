//! The masked display text matches Node `sanitizeHookDisplayText` (cases produced by running Node's function).
use serde_json::json;

use super::*;

#[test]
fn sanitize_matches_node() {
    let cases = [
        ("node server.js --api-key sk-123 --flag", "node server.js --api-key •••• --flag"),
        ("/usr/bin/env TOKEN=abc run", "/usr/bin/env TOKEN=•••• run"),
        (
            "curl https://user:pass@example.com/x?access_token=zzz&b=1",
            "curl https://••••:••••@example.com/x?access_token=••••",
        ),
        ("Authorization: Bearer abc.def, next", "Authorization: Bearer ••••, next"),
        ("authorization = 'quoted value' tail", "authorization = •••• tail"),
        (
            r#"{"client_secret": "s3", "my-api-key":42}"#,
            r#"{"client_secret": ••••, "my-api-key":••••"#,
        ),
        ("x MY_PASSWORD: hunter2\nAPI_KEY=1 y", "x MY_PASSWORD: ••••\nAPI_KEY=•••• y"),
        (r#"--Private-Key "a b" --other"#, "--Private-Key •••• --other"),
        ("tokenizer stays, Tokens: x", "tokenizer stays, Tokens: x"),
        ("plain text", "plain text"),
    ];
    for (input, expected) in cases {
        assert_eq!(sanitize(input), expected, "{input}");
    }
}

#[test]
fn remote_display_drops_credentials_and_omits_a_missing_oauth() {
    let config = json!({"type": "http", "url": "https://u:p@example.com/mcp?token=a#f", "headers": {"B": "1", "A": "2"}});
    let shown = display(config.as_object().unwrap(), "/ws").unwrap();
    assert_eq!(
        shown,
        "{\n  \"type\": \"http\",\n  \"url\": \"https://example.com/mcp\",\n  \"headers\": [\n    \"B\",\n    \"A\"\n  ]\n}"
    );
    let config = json!({"type": "sse", "url": "not a url"});
    assert_eq!(display(config.as_object().unwrap(), "/ws"), None);
}
