use std::collections::BTreeMap;

use super::*;

fn launch() -> AcpLaunch {
    AcpLaunch {
        agent_id: "opencode".to_owned(),
        command: "opencode".to_owned(),
        args: vec!["acp".to_owned()],
        env: None,
        cwd: "/tmp/work".to_owned(),
    }
}

fn message(launch: &AcpLaunch) -> String {
    validate(launch).expect_err("invalid").message
}

/// Digests produced by Node `acpLaunchKey` for the same launches (computed with `node -e`).
#[test]
fn launch_key_matches_node() {
    let mut env = BTreeMap::new();
    env.insert("ZED".to_owned(), "1".to_owned());
    env.insert("ALPHA".to_owned(), "é ✓".to_owned());
    let first = AcpLaunch {
        args: vec!["acp".to_owned(), "--port".to_owned(), "0".to_owned()],
        env: Some(env),
        ..launch()
    };
    assert_eq!(
        fingerprint(&first),
        r#"{"agentId":"opencode","command":"opencode","args":["acp","--port","0"],"env":[["ALPHA","é ✓"],["ZED","1"]],"cwd":"/tmp/work"}"#
    );
    assert_eq!(
        launch_key(&first),
        "23229669daf6ef6ea5f56f6ce2c9abef3f9935914070289fecb2a9e37504b9bc"
    );
    let second = AcpLaunch {
        agent_id: "cursor".to_owned(),
        command: "cursor-agent".to_owned(),
        cwd: "/w".to_owned(),
        ..launch()
    };
    assert_eq!(
        launch_key(&second),
        "18e6854a236e9552111b7f3ed1653b0c01075956dfa8c96dcd2b9bcd731d4779"
    );
}

#[test]
fn validation_messages_match_the_shared_rules() {
    assert!(validate(&launch()).is_ok());
    let blank = AcpLaunch {
        command: "  ".to_owned(),
        ..launch()
    };
    assert_eq!(message(&blank), "command must be a non-empty string");
    let long = AcpLaunch {
        command: "x".repeat(4097),
        ..launch()
    };
    assert_eq!(message(&long), "command exceeds 4096 characters");
    let newline = AcpLaunch {
        command: "open\ncode".to_owned(),
        ..launch()
    };
    assert_eq!(
        message(&newline),
        "command must not contain NUL, CR or LF characters"
    );
    let many = AcpLaunch {
        args: vec![String::new(); 33],
        ..launch()
    };
    assert_eq!(message(&many), "args must contain at most 32 entries");
    let mut env = BTreeMap::new();
    env.insert("LD_PRELOAD".to_owned(), "x".to_owned());
    let loader = AcpLaunch {
        env: Some(env),
        ..launch()
    };
    assert_eq!(
        message(&loader),
        "env key \"LD_PRELOAD\" is a loader/injection variable and cannot be set"
    );
    let mut env = BTreeMap::new();
    env.insert("1BAD".to_owned(), "x".to_owned());
    let bad = AcpLaunch {
        env: Some(env),
        ..launch()
    };
    assert_eq!(
        message(&bad),
        "env key \"1BAD\" is not a valid environment name"
    );
    let relative = AcpLaunch {
        cwd: "work".to_owned(),
        ..launch()
    };
    assert_eq!(message(&relative), "cwd must be an absolute path");
}

#[test]
fn child_env_drops_runtime_and_secret_keys_and_applies_overrides() {
    let parent: Vec<(String, String)> = [
        ("PATH", "/bin"),
        ("HOME", "/home/u"),
        ("OPENAI_API_KEY", "s"),
        ("GITHUB_TOKEN", "s"),
        ("MONKEY", "kept"),
        ("TOKENIZER", "kept"),
        ("NODE_OPTIONS", "kept-from-parent"),
        ("https_proxy", "p"),
        ("npm_config_proxy", "p"),
        ("ZCODE_OFFICIAL_ENDPOINT_TOKEN", "s"),
        ("SSH_AUTH_SOCK", "/sock"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect();
    let mut overrides = BTreeMap::new();
    overrides.insert("MY_TOKEN".to_owned(), "explicit".to_owned());
    let env = child_env(&parent, Some(&overrides)).expect("env");
    let keys: Vec<&str> = env.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "HOME",
            "MONKEY",
            "MY_TOKEN",
            "NODE_OPTIONS",
            "PATH",
            "SSH_AUTH_SOCK",
            "TOKENIZER"
        ]
    );
    let mut loader = BTreeMap::new();
    loader.insert("DYLD_INSERT_LIBRARIES".to_owned(), "x".to_owned());
    assert_eq!(
        child_env(&parent, Some(&loader))
            .expect_err("loader")
            .message,
        "env key \"DYLD_INSERT_LIBRARIES\" is a loader/injection variable"
    );
}
