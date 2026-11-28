use super::*;

use super::super::config::{McpScope, McpServerOptions};

fn stdio(name: &str, command: &str, args: &[&str], env: &[(&str, &str)]) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::User,
        transport: McpTransportConfig::Stdio {
            command: command.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            cwd: None,
        },
        options: McpServerOptions::default(),
        machine: Default::default(),
        oauth: None,
    }
}

#[test]
fn the_old_computer_use_name_is_retired_but_node_repl_never_is() {
    assert!(is_retired_cua_server(&stdio(
        "computer-use",
        "node",
        &[],
        &[]
    )));
    assert!(!is_retired_cua_server(&stdio(
        "node_repl",
        "zcode-cua",
        &[],
        &[("ZCODE_PLUGIN_ID", "computer-use@zcode-plugins-official")]
    )));
}

#[test]
fn the_official_plugin_id_in_the_env_is_retired_trimmed_and_lowercased() {
    let env = [("ZCODE_PLUGIN_ID", "  Computer-Use@ZCode-Plugins-Official ")];
    assert!(is_retired_cua_server(&stdio("cua", "helper", &[], &env)));
    let other = [("ZCODE_PLUGIN_ID", "documents@zcode-plugins-official")];
    assert!(!is_retired_cua_server(&stdio(
        "docs",
        "helper",
        &[],
        &other
    )));
}

#[test]
fn a_command_or_arg_that_names_the_package_is_retired() {
    for command in [
        "zcode-cua",
        "zcode_cua",
        "/opt/bin/zcode-cua",
        "C:\\tools\\zcode-cua\\",
        "zcode-cua@1.2.3",
        "zcode-cua==1.2.3",
        "zcode-cua[macos]",
        "zcode-cua.git",
    ] {
        assert!(
            is_retired_cua_server(&stdio("x", command, &[], &[])),
            "{command}"
        );
    }
    for args in [
        &["--from", "zcode-cua", "run"][..],
        &["-m", "zcode_cua.server"][..],
        &["git+https://example.test/zcode-cua.git@v1"][..],
        &["--from", "/work/zcode-cua/"][..],
    ] {
        assert!(
            is_retired_cua_server(&stdio("x", "uvx", args, &[])),
            "{args:?}"
        );
    }
}

#[test]
fn near_misses_and_other_transports_are_kept() {
    for command in ["zcode-cua-proxy", "ZCODE-CUA", "my-zcode-cua", "node"] {
        assert!(
            !is_retired_cua_server(&stdio("x", command, &[], &[])),
            "{command}"
        );
    }
    let remote = McpServer {
        transport: McpTransportConfig::Http {
            url: "https://example.test/zcode-cua".to_owned(),
            headers: Default::default(),
        },
        ..stdio("computer-use", "node", &[], &[])
    };
    assert!(!is_retired_cua_server(&remote));
}
