//! MCP 配置的解析、`${VAR}` 展开与作用域合并（ext.md §3.1）。

use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::json;

use super::*;

fn lookup(name: &str) -> Option<String> {
    (name == "TOKEN").then(|| "secret".to_owned())
}

#[test]
fn servers_parse_with_variables_expanded() {
    let table = json!({
        "web": {"type": "http", "url": "https://mcp.example.com/${PATH_PART:-mcp}", "headers": {"authorization": "Bearer ${TOKEN}"}},
        "files": {"command": "node", "args": ["server.js", "${MISSING}"], "env": {"KEY": "${TOKEN}"}},
        "bad": {"type": "ws", "url": "wss://x"},
        "nocmd": {"type": "stdio"}
    });
    let (servers, warnings) = parse_servers(&table, McpScope::Project, &EnvLookups::same(&lookup));
    let names: Vec<&str> = servers.iter().map(|server| server.name.as_str()).collect();
    assert_eq!(names, ["files", "web"]);
    let McpTransportConfig::Stdio { args, env, .. } = &servers[0].transport else {
        panic!("files is stdio");
    };
    assert_eq!(args, &["server.js", "${MISSING}"]);
    assert_eq!(env["KEY"], "secret");
    let McpTransportConfig::Http { url, headers } = &servers[1].transport else {
        panic!("web is http");
    };
    assert_eq!(url, "https://mcp.example.com/mcp");
    assert_eq!(headers["authorization"], "Bearer secret");
    assert_eq!(warnings.len(), 3, "{warnings:?}");
    assert!(warnings.iter().any(|warning| warning.contains("MISSING")));
}

#[test]
fn servers_bound_to_a_remote_machine_keep_their_variables() {
    // R5（remote-exec.md §22.7）：绑定到远端机器的服务器按原文解析，本机的值（这里的 TOKEN）不进请求。
    let table = json!({
        "remote": {"command": "server", "args": ["${TOKEN}"], "env": {"KEY": "${TOKEN:-none}"}},
        "here": {"command": "server", "args": ["${TOKEN}"]}
    });
    let (servers, warnings) = parse_servers_keeping(
        &table,
        McpScope::Dynamic,
        &EnvLookups::same(&lookup),
        &|name| name == "remote",
    );
    assert!(warnings.is_empty(), "{warnings:?}");
    let McpTransportConfig::Stdio { args, .. } = &servers[0].transport else {
        panic!("here is stdio");
    };
    assert_eq!(args, &["secret"]);
    let McpTransportConfig::Stdio { args, env, .. } = &servers[1].transport else {
        panic!("remote is stdio");
    };
    assert_eq!(args, &["${TOKEN}"]);
    assert_eq!(env["KEY"], "${TOKEN:-none}");
}

/// 普通位（command、args、url）与敏感位（env、headers 的值）分开查表：`SECRET` 只在敏感位解析，普通位保持
/// 原样（Node `template.ts` `resolveTemplate` 的 `allowSensitive` 之分——秘密不进 args 或 URL）。
#[test]
fn plain_fields_do_not_expand_sensitive_only_names() {
    let plain = |name: &str| (name == "ZCODE_PROJECT_DIR").then(|| "/project".to_owned());
    let sensitive = |name: &str| {
        if name == "ZCODE_PROJECT_DIR" {
            Some("/project".to_owned())
        } else {
            (name == "SECRET").then(|| "s3cret".to_owned())
        }
    };
    let table = json!({
        "db": {"command": "node", "args": ["--dir", "${ZCODE_PROJECT_DIR}", "--token", "${SECRET}"],
               "env": {"TOKEN": "${SECRET}", "ROOT": "${ZCODE_PROJECT_DIR}"}},
        "web": {"type": "http", "url": "https://${SECRET}/mcp", "headers": {"authorization": "Bearer ${SECRET}"}}
    });
    let lookups = EnvLookups {
        plain: &plain,
        sensitive: &sensitive,
    };
    let (servers, warnings) = parse_servers(&table, McpScope::Plugin, &lookups);
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(warnings.iter().all(|warning| warning.contains("SECRET")));
    let McpTransportConfig::Stdio {
        command, args, env, ..
    } = &servers[0].transport
    else {
        panic!("db is stdio");
    };
    assert_eq!(command, "node");
    assert_eq!(args[0], "--dir");
    // 普通位：`ZCODE_` 名字解析（Node 在 `allowSensitive` 判定之前），其余保持原样。
    assert_eq!(args[1], "/project");
    assert_eq!(args[2], "--token");
    assert_eq!(args[3], "${SECRET}");
    // 敏感位：任意合法名字都解析。
    assert_eq!(env["TOKEN"], "s3cret");
    assert_eq!(env["ROOT"], "/project");
    let McpTransportConfig::Http { url, headers } = &servers[1].transport else {
        panic!("web is http");
    };
    assert_eq!(url, "https://${SECRET}/mcp");
    assert_eq!(headers["authorization"], "Bearer s3cret");
}

fn server(name: &str, scope: McpScope, command: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope,
        transport: McpTransportConfig::stdio(command.to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }
}

#[test]
fn local_beats_project_beats_user_and_enterprise_is_exclusive() {
    let merged = merge_scopes(vec![
        vec![
            server("a", McpScope::User, "user"),
            server("b", McpScope::User, "user"),
        ],
        vec![server("a", McpScope::Project, "project")],
        vec![
            server("a", McpScope::Local, "local"),
            server("c", McpScope::Local, "local"),
        ],
    ]);
    let summary: Vec<(String, McpScope)> = merged
        .iter()
        .map(|server| (server.name.clone(), server.scope))
        .collect();
    assert_eq!(
        summary,
        [
            ("a".to_owned(), McpScope::Local),
            ("b".to_owned(), McpScope::User),
            ("c".to_owned(), McpScope::Local)
        ]
    );
    let only = merge_scopes(vec![
        vec![server("x", McpScope::Enterprise, "corp")],
        vec![server("y", McpScope::User, "user")],
    ]);
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].name, "x");
}

/// PR4 (1): plugin servers read `oauth` with Node's lenient rules (`resolveMcpOAuthConfig`). The secret expands
/// through the sensitive lookup and the other fields through the plain one.
#[test]
fn plugin_servers_read_their_oauth_block_leniently() {
    use crate::mcp::oauth::McpOAuthConfig;
    let table = json!({
        "canva": {
            "type": "http",
            "url": "https://mcp.example.com/mcp",
            "oauth": {"type": "authorization_code", "clientId": "${TOKEN}", "scope": "mcp:tools", "unknown": 1}
        },
        "secret": {
            "type": "http",
            "url": "https://mcp.example.com/cc",
            "oauth": {"type": "client_credentials", "clientId": "cid", "clientSecret": "${TOKEN}", "scope": 3}
        },
        "unsupported": {"type": "http", "url": "https://mcp.example.com/x", "oauth": {"type": "device"}},
        "missing_secret": {"type": "http", "url": "https://mcp.example.com/y", "oauth": {"type": "client_credentials", "clientId": "cid"}},
        "stdio_block": {"command": "node", "oauth": {"type": "authorization_code"}}
    });
    let (servers, warnings) = parse_servers(&table, McpScope::Plugin, &EnvLookups::same(&lookup));
    let by_name = |name: &str| servers.iter().find(|server| server.name == name);
    assert!(
        matches!(
            by_name("canva").and_then(|server| server.oauth.as_ref()),
            Some(McpOAuthConfig::AuthorizationCode { client_id: Some(id), scope: Some(scope), .. })
                if id == "secret" && scope == "mcp:tools"
        ),
        "canva oauth: {:?}",
        by_name("canva").map(|server| &server.oauth)
    );
    assert!(matches!(
        by_name("secret").and_then(|server| server.oauth.as_ref()),
        Some(McpOAuthConfig::ClientCredentials { client_secret, scope: None, .. })
            if client_secret == "secret"
    ));
    assert!(by_name("unsupported").is_none());
    assert!(by_name("missing_secret").is_none());
    assert!(by_name("stdio_block").is_some_and(|server| server.oauth.is_none()));
    assert_eq!(warnings.len(), 2, "warnings: {warnings:?}");
}

/// PR4 (1): user servers keep the strict parser, so their `oauth` is not read here.
#[test]
fn user_servers_do_not_read_the_plugin_oauth_block() {
    let table = json!({
        "web": {"type": "http", "url": "https://mcp.example.com/mcp", "oauth": {"type": "authorization_code"}}
    });
    let (servers, _) = parse_servers(&table, McpScope::User, &EnvLookups::same(&lookup));
    assert!(servers[0].oauth.is_none());
}

/// Review #2: the diagnostic names the declared `type` the way Node's `String(value.type)` does, so a non-string value
/// is shown rather than `undefined`.
#[test]
fn an_unsupported_oauth_type_is_named_as_declared() {
    let table = json!({
        "numeric": {"type": "http", "url": "https://mcp.example.com/n", "oauth": {"type": 3}},
        "null": {"type": "http", "url": "https://mcp.example.com/z", "oauth": {"type": null}}
    });
    let (_, warnings) = parse_servers(&table, McpScope::Plugin, &EnvLookups::same(&lookup));
    let text = format!("{warnings:?}");
    assert!(text.contains("Unsupported MCP OAuth type: 3"), "{text}");
    assert!(text.contains("Unsupported MCP OAuth type: null"), "{text}");
}
