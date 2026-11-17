//! MCP 服务器配置的解析与 `${VAR}` 展开（docs/specs/rust-cli/ext.md §3.1）：配置的 schema 与字符串里的变量展开。
//! `expandEnvVarsInString`）。读文件是入口层的事：它把读到的 JSON 与环境变量交给这里。

use std::collections::BTreeMap;

use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::Value;

use super::config::{McpScope, McpServer};

/// `${VAR}` 与 `${VAR:-默认}` 展开：规则只有一份，在 kernel-api（远端的执行器也用它，remote-exec.md §22.7）。
pub use rust_cli_kernel_api::mcp_vars::expand_vars;

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|fields| {
            fields
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// `${VAR}` 的查表对（Node `adapters/src/plugins/template.ts` `resolveTemplate` 的 `allowSensitive` 之分）：
/// 普通位（command、args、url）查 [`Self::plain`]，敏感位（`env` 与 `headers` 的值）查 [`Self::sensitive`]——任意
/// 环境变量名只在敏感位解析，秘密不进 command、args 或 URL。两套一样时（非插件的配置：入口的进程环境）用
/// [`EnvLookups::same`]。
pub struct EnvLookups<'a> {
    pub plain: &'a dyn Fn(&str) -> Option<String>,
    pub sensitive: &'a dyn Fn(&str) -> Option<String>,
}

impl<'a> EnvLookups<'a> {
    /// 两套同一个查表。
    pub fn same(lookup: &'a dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            plain: lookup,
            sensitive: lookup,
        }
    }
}

/// 一台服务器的字符串字段展开：查表对（见 [`EnvLookups`]）加这台服务器自己的状态（远端绑定的按原文、缺的名字）。
struct Fields<'a> {
    lookups: &'a EnvLookups<'a>,
    /// 远端绑定的服务器（R5，remote-exec.md §22.7）：按原文，`${VAR}` 留给那台机器的执行器，也不记 missing。
    kept: bool,
    missing: Vec<String>,
}

impl Fields<'_> {
    /// 普通位（Node `allowSensitive: false`）：command、args、url。
    fn plain(&mut self, text: &str) -> String {
        self.expand(text, self.lookups.plain)
    }

    /// 敏感位（Node `allowSensitive: true`）：`env` 与 `headers` 的值。
    fn sensitive(&mut self, text: &str) -> String {
        self.expand(text, self.lookups.sensitive)
    }

    fn expand(&mut self, text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
        if self.kept {
            text.to_owned()
        } else {
            expand_vars(text, lookup, &mut self.missing)
        }
    }
}

/// 一个服务器的配置；不认识的形状返回原因。
fn transport(config: &Value, fields: &mut Fields<'_>) -> Result<McpTransportConfig, String> {
    let kind = config
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    let url = || {
        config
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing url".to_owned())
    };
    match kind {
        "stdio" => {
            let command = config
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing command".to_owned())?;
            Ok(McpTransportConfig::Stdio {
                command: fields.plain(command),
                args: strings(config.get("args"))
                    .iter()
                    .map(|arg| fields.plain(arg))
                    .collect(),
                env: string_map(config.get("env"))
                    .into_iter()
                    .map(|(key, value)| (key, fields.sensitive(&value)))
                    .collect(),
                cwd: None,
            })
        }
        "sse" | "http" => {
            let url = fields.plain(url()?);
            let headers = string_map(config.get("headers"))
                .into_iter()
                .map(|(key, value)| (key, fields.sensitive(&value)))
                .collect();
            Ok(if kind == "sse" {
                McpTransportConfig::sse(url, headers)
            } else {
                McpTransportConfig::http(url, headers)
            })
        }
        other => Err(format!("unsupported transport type \"{other}\"")),
    }
}

/// 服务器表（`mcpServers` 的值）里的服务器，按名字排序；返回服务器与警告。
pub fn parse_servers(
    servers: &Value,
    scope: McpScope,
    lookups: &EnvLookups<'_>,
) -> (Vec<McpServer>, Vec<String>) {
    parse_servers_keeping(servers, scope, lookups, &|_| false)
}

/// 同 [`parse_servers`]；`keep(名字)` 为真的服务器按原文、不展开 `${VAR}`（绑定到远端机器的，本机的值不进请求）。
pub fn parse_servers_keeping(
    servers: &Value,
    scope: McpScope,
    lookups: &EnvLookups<'_>,
    keep: &dyn Fn(&str) -> bool,
) -> (Vec<McpServer>, Vec<String>) {
    let mut found = Vec::new();
    let mut warnings = Vec::new();
    let Some(entries) = servers.as_object() else {
        if !servers.is_null() {
            warnings.push("mcpServers must be a JSON object".to_owned());
        }
        return (found, warnings);
    };
    let mut names: Vec<&String> = entries.keys().collect();
    names.sort();
    for name in names {
        let mut fields = Fields {
            lookups,
            kept: keep(name),
            missing: Vec::new(),
        };
        let parsed = transport(&entries[name], &mut fields);
        match parsed {
            Ok(transport) => {
                if !fields.missing.is_empty() {
                    warnings.push(format!(
                        "MCP server \"{name}\": missing environment variables: {}",
                        fields.missing.join(", ")
                    ));
                }
                found.push(McpServer {
                    name: name.clone(),
                    scope,
                    transport,
                    options: Default::default(),
                    oauth: None,
                    machine: Default::default(),
                });
            }
            Err(reason) => warnings.push(format!("MCP server \"{name}\" skipped: {reason}")),
        }
    }
    (found, warnings)
}

/// 按作用域合并（ext.md §3.1）：enterprise 存在时只用它；否则 user < project < local，dynamic 覆盖同名。
pub fn merge_scopes(layers: Vec<Vec<McpServer>>) -> Vec<McpServer> {
    let all: Vec<McpServer> = layers.into_iter().flatten().collect();
    if all
        .iter()
        .any(|server| server.scope == McpScope::Enterprise)
    {
        return all
            .into_iter()
            .filter(|server| server.scope == McpScope::Enterprise)
            .collect();
    }
    // 同名时后者覆盖前者：插件 < 用户 < 项目 < 本地 < 动态与企业。
    const PLUGIN_RANK: u8 = 0;
    const USER_RANK: u8 = 1;
    const PROJECT_RANK: u8 = 2;
    const LOCAL_RANK: u8 = 3;
    const DYNAMIC_RANK: u8 = 4;
    let rank = |scope: McpScope| match scope {
        McpScope::Plugin => PLUGIN_RANK,
        McpScope::User => USER_RANK,
        McpScope::Project => PROJECT_RANK,
        McpScope::Local => LOCAL_RANK,
        McpScope::Dynamic | McpScope::Enterprise => DYNAMIC_RANK,
    };
    let mut merged: BTreeMap<String, McpServer> = BTreeMap::new();
    for server in all {
        let keep = merged
            .get(&server.name)
            .is_none_or(|known| rank(server.scope) >= rank(known.scope));
        if keep {
            merged.insert(server.name.clone(), server);
        }
    }
    merged.into_values().collect()
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
