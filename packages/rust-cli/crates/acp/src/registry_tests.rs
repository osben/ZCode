use super::*;

#[test]
fn display_names_and_login_commands_follow_the_node_registry() {
    assert_eq!(display_name("cursor"), "Cursor");
    assert_eq!(display_name("mock"), "mock");
    assert_eq!(login_command("opencode"), "opencode auth login");
    assert_eq!(login_command("cursor"), "cursor-agent login");
    assert_eq!(login_command("qwen"), "qwen");
    assert_eq!(login_command("mock"), "mock");
}

#[test]
fn the_auth_pattern_matches_like_the_node_regex() {
    for text in [
        "Authentication required",
        "not authorized",
        "auth failed",
        "please sign in",
        "Sign-in needed",
        "signin",
        "log in first",
        "Login expired",
        "Unauthorised",
        "missing credentials",
        "x-auth",
    ] {
        assert!(is_auth_failure(text), "{text}");
    }
    for text in [
        "author unknown",
        "oauthx",
        "authority",
        "blogging",
        "process exited",
    ] {
        assert!(!is_auth_failure(text), "{text}");
    }
}
