//! `/mcp reconnect|enable|disable`（docs/specs/rust-cli/tui-manage.md §6.1）：连接任务的唯一 owner 是
//! [`McpManager`]。重连与停用时代号加一、发取消消息并关闭旧客户端，旧任务之后的更新因代号不符被丢弃；
//! 等待用状态变化的 watch，不用超时。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::BTreeSet;
use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::env_registry::EnvironmentRegistry;
use rust_cli_kernel_api::manage::{McpAction, McpServerInfo};
use tokio_util::sync::CancellationToken;

use super::app_connection;
use super::{McpManager, McpServer, McpStatus, Server};
use crate::mcp::retired::is_retired_cua_server;

impl McpManager {
    /// 启动时停用的服务器（配置里 `enabled: false`）：登记为 disabled，不连接；`/mcp enable` 时才连。
    pub fn register_disabled(&self, servers: Vec<McpServer>) {
        {
            let mut known = self.0.servers();
            for config in servers
                .into_iter()
                .filter(|server| !is_retired_cua_server(server))
            {
                known
                    .entry(config.name.clone())
                    .or_insert_with(|| Server::new(config, McpStatus::Disabled));
            }
        }
        self.0.changed.send_modify(|version| *version += 1);
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md): stops every connection task of this group
    /// (a workspace layer that turned `Invalid`, or a replaced group). The cancelled tasks drop
    /// their sessions, which ends the stdio children; late status updates find no entry and no-op.
    pub fn shutdown(&self) {
        // Fork (F7 PR 1): a published client that goes away is a new app connection, so its listeners run (after the
        // lock), as `retire` does: a panel of the replaced group is revoked rather than left with a dead lease.
        let listeners: Vec<_> = {
            let mut servers = self.0.servers();
            let mut listeners = Vec::new();
            for (_, server) in servers.iter_mut() {
                server.cancel.cancel();
                if server.client.is_some() {
                    listeners.extend(
                        server
                            .app_listeners
                            .iter()
                            .map(|(_, listener)| listener.clone()),
                    );
                }
            }
            servers.clear();
            listeners
        };
        for listener in listeners {
            listener();
        }
        self.0.changed.send_modify(|version| *version += 1);
    }

    /// 停掉当前连接任务并换成 `status`；返回旧客户端（由调用方关闭）与新的代号和取消消息。
    fn retire(
        &self,
        name: &str,
        status: McpStatus,
    ) -> Option<(
        McpServer,
        Option<std::sync::Arc<super::Client>>,
        u64,
        CancellationToken,
    )> {
        let mut servers = self.0.servers();
        let server = servers.get_mut(name)?;
        let (client, listeners) = reset(server, status);
        let out = (
            server.config.clone(),
            client,
            server.generation,
            server.cancel.clone(),
        );
        drop(servers);
        for listener in listeners {
            listener();
        }
        Some(out)
    }

    /// 重新连一个服务器（重连与启用共用）。
    pub(crate) async fn restart(&self, name: &str) {
        let Some((config, client, generation, cancel)) = self.retire(name, McpStatus::CONNECTING)
        else {
            return;
        };
        self.0.changed.send_modify(|version| *version += 1);
        if let Some(client) = client {
            client.close().await;
        }
        let workspace = self.0.workspace.lock_unpoisoned().clone();
        let Some(workspace) = workspace else {
            return;
        };
        let task = self.0.clone().run(workspace, config, generation, cancel);
        self.0.spawner.spawn_resident("mcp-connection", task);
    }

    /// 跟着注册表的连接变化（F98，remote-exec.md §25.5）：一台机器进注册表时（`/machines add` / `connect` 连上、失败之后
    /// 再连上），绑定到它、现在是失败状态的服务器重连一次（同 `/mcp reconnect`）。ssh 抖动时机器一直在注册表里，不触发。
    ///
    /// 缺陷修复（Docker 试用 L6）：以前机器后来连上时，启动时因为它不在清单里而失败的服务器一直是“未连接”，要手动
    /// `/mcp reconnect`。
    pub(super) async fn follow_machines(&self, registry: Arc<dyn EnvironmentRegistry>) {
        let names = |registry: &dyn EnvironmentRegistry| -> BTreeSet<String> {
            registry.machines().names().into_iter().collect()
        };
        let mut seen = names(registry.as_ref());
        let mut changes = registry.changes();
        while changes.next().await.is_some() {
            let now = names(registry.as_ref());
            let arrived: Vec<String> = now.difference(&seen).cloned().collect();
            seen = now;
            for machine in arrived {
                let failed: Vec<String> = self
                    .0
                    .servers()
                    .iter()
                    .filter(|(_, server)| {
                        server.config.machine.remote() == Some(machine.as_str())
                            && matches!(server.status, McpStatus::Failed { .. })
                    })
                    .map(|(name, _)| name.clone())
                    .collect();
                for name in failed {
                    tracing::info!(server = %name, %machine, "reconnecting an MCP server whose machine connected");
                    self.restart(&name).await;
                }
            }
        }
    }

    async fn stop(&self, name: &str) {
        let Some((_, client, _, _)) = self.retire(name, McpStatus::Disabled) else {
            return;
        };
        self.0.changed.send_modify(|version| *version += 1);
        if let Some(client) = client {
            client.close().await;
        }
    }

    fn status_of(&self, name: &str) -> Option<McpStatus> {
        self.0
            .servers()
            .get(name)
            .map(|server| server.status.clone())
    }

    /// 对这些服务器做一个动作，等重连与启用的服务器离开 connecting，返回它们改动后的状态。
    /// reconnect 跳过停用的；enable 只动停用的；disable 跳过已经停用的。不认识的名字不在结果里。
    pub async fn control(&self, action: McpAction, names: &[String]) -> Vec<McpServerInfo> {
        for name in names {
            let Some(status) = self.status_of(name) else {
                continue;
            };
            match (action, status) {
                (McpAction::Reconnect, McpStatus::Disabled)
                | (
                    McpAction::Enable,
                    McpStatus::Pending { .. }
                    | McpStatus::Connected { .. }
                    | McpStatus::Failed { .. },
                )
                | (McpAction::Disable, McpStatus::Disabled) => {}
                (McpAction::Reconnect | McpAction::Enable, _) => self.restart(name).await,
                (McpAction::Disable, _) => self.stop(name).await,
            }
        }
        let mut changes = self.0.changed.subscribe();
        loop {
            let pending = names
                .iter()
                .any(|name| self.status_of(name).is_some_and(|status| status.pending()));
            if !pending || changes.changed().await.is_err() {
                break;
            }
        }
        self.server_infos()
            .into_iter()
            .filter(|info| names.contains(&info.name))
            .collect()
    }
}

/// Ends the connection task of `server` and puts `status` in its place: the generation moves on (a late update of
/// the old task is dropped), the catalog and the app view are cleared. Returns the old client for the caller to close
/// and the app listeners to run after the lock is released.
pub(super) fn reset(
    server: &mut Server,
    status: McpStatus,
) -> (
    Option<Arc<super::Client>>,
    Vec<super::app_connection::Listener>,
) {
    server.cancel.cancel();
    server.generation += 1;
    server.cancel = CancellationToken::new();
    server.deferred = false;
    server.status = status;
    server.tools.clear();
    server.prompts.clear();
    server.instructions = None;
    server.resources = false;
    // Fork (F7 PR 4): the subscriptions of the retired connection go with it.
    server.resource_subs.clear();
    server.resources_subscribe = false;
    let client = server.client.take();
    // Fork (F7 PR 1): dropping a published client is a new app connection, so its listeners run (after the lock).
    let listeners = if client.is_some() {
        server.app_generation = app_connection::next_generation();
        server
            .app_listeners
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect()
    } else {
        Vec::new()
    };
    (client, listeners)
}

#[cfg(test)]
#[path = "manager_control_tests.rs"]
mod tests;
