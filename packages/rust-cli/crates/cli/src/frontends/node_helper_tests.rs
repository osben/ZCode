use super::*;

fn parsed(raw: &str) -> Command {
    parse(Some(raw)).expect("valid").expect("configured")
}

#[test]
fn unset_or_blank_means_no_helper() {
    assert_eq!(parse(None), Ok(None));
    assert_eq!(parse(Some("")), Ok(None));
    assert_eq!(parse(Some("   ")), Ok(None));
}

#[test]
fn command_args_and_env_are_read() {
    let command = parsed(
        r#"{"command": "/opt/node", "args": ["/bundle.js", "__zcode-rust-helper", "--stdio"],
            "env": {"ELECTRON_RUN_AS_NODE": "1"}}"#,
    );
    assert_eq!(command.program, "/opt/node");
    assert_eq!(
        command.args,
        vec!["/bundle.js", "__zcode-rust-helper", "--stdio"]
    );
    assert_eq!(
        command.env,
        vec![("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned())]
    );
}

#[test]
fn args_and_env_default_to_empty() {
    let command = parsed(r#"{"command": "node"}"#);
    assert!(command.args.is_empty());
    assert!(command.env.is_empty());
}

#[test]
fn invalid_values_are_refused_without_echoing_them() {
    let secret = "sk-live-do-not-log";
    let cases = [
        format!("{{not json {secret}"),
        format!("[\"{secret}\"]"),
        r#"{"args": []}"#.to_owned(),
        r#"{"command": ""}"#.to_owned(),
        format!(r#"{{"command": "node", "args": "{secret}"}}"#),
        r#"{"command": "node", "args": [1]}"#.to_owned(),
        format!(r#"{{"command": "node", "env": ["{secret}"]}}"#),
        r#"{"command": "node", "env": {"K": 3}}"#.to_owned(),
    ];
    for raw in cases {
        let reason = parse(Some(&raw)).expect_err("refused");
        assert!(
            !reason.contains(secret),
            "the reason echoes the value: {reason}"
        );
    }
}
