//! App 协议的前端（docs/specs/rust-cli/app-protocol.md §3.4）：Host 经 stdio 驱动的 V4 方法、命令、三种主题与 Host
//! 还在调用的旧方法。与 tui、headless 同层：只经内核的会话 API 与平台层，协议的机制在 protocol-core。
//!
//! 入口（cli 的 `app-server --stdio`）的顺序：[`connection::start`](rust_cli_protocol_core::connection::start) 起写者，
//! [`Context::new`]；[`connection::serve`](rust_cli_protocol_core::connection::serve) 配 [`connection::Deferred`] 在组装
//! 之前就开始读 Host 的输入（自己请求的回复要在组装期间送达，例如凭据加解密）；马上 [`Startup::checking`]（Host 要求 30 s
//! 内有首帧）；用 [`HostHeaders`] 与 [`HostCredentialCipher`] 组装平台层与内核；[`Startup::ready`] 或 [`Startup::failed`]；
//! 内核装好后 [`handler`] 交给 `Deferred` 的安装端，之后 Host 的请求才被处理。Host 关掉输入时读者结束。
//! （specs/fork-rust-credential-cipher.md，「Startup ordering」）

mod attach;
mod attachment_share;
mod attachment_text;
mod attachments;
mod child_runs;
mod cipher;
mod commands;
pub mod context;
mod fork;
pub mod headers;
mod inbound;
mod inbox;
mod index;
mod legacy;
mod lifecycle;
mod live;
mod preparation;
mod projection;
mod reservations;
mod server;
mod subscribe;
mod telemetry;
mod uploads;
mod wire;
mod worktree;

use std::sync::Arc;

use rust_cli_base::Spawner;
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_protocol_core::connection;
use serde_json::json;

pub use attach::{AttachGate, HOST_ATTACH_ACK_ENV};
pub use cipher::HostCredentialCipher;
pub use context::Context;
pub use headers::HostHeaders;
pub use server::Defaults;

/// 存储的启动状态（`startup/storageState`，`zcodeStorageStartupStateSchema`）：checking → ready / failed。迁移与备份只由
/// Node 的存储准备 Worker 做，这里只报本进程打开会话库的结果。
pub struct Startup {
    context: Arc<Context>,
    attempt: String,
    database: String,
    sequence: std::sync::atomic::AtomicU64,
    started: u64,
}

pub const STORAGE_STATE: &str = "startup/storageState";

impl Startup {
    /// `database` 是不带路径与凭据的不透明 ID（同一个进程里不变）。
    pub fn new(context: Arc<Context>, database: impl Into<String>) -> Self {
        Self {
            attempt: context.fresh("attempt"),
            started: context.now(),
            context,
            database: database.into(),
            sequence: std::sync::atomic::AtomicU64::new(0),
        }
    }

    async fn send(&self, phase: &str, error: Option<&str>) {
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        let mut state = json!({
            "schemaVersion": 1,
            "attemptId": self.attempt,
            "sequence": sequence,
            "databaseId": self.database,
            "databaseKind": "session",
            "phase": phase,
            "elapsedMs": self.context.now().saturating_sub(self.started),
        });
        if let Some(code) = error {
            state["errorCode"] = json!(code);
        }
        self.context.peer.notify(STORAGE_STATE, &state).await;
    }

    pub async fn checking(&self) {
        self.send("checking", None).await;
    }

    pub async fn ready(&self) {
        self.send("ready", None).await;
    }

    /// `code` 是 `databaseStartupErrorCodeSchema` 的值（例如 `open_failed`、`unsupported_runtime`）。
    pub async fn failed(&self, code: &str) {
        self.send("failed", Some(code)).await;
    }
}

/// 协议的处理方（不读输入）：启动时可以先开读者（[`connection::Deferred`]），内核装好后再交给它。
pub fn handler(
    context: Arc<Context>,
    kernel: Arc<dyn Kernel>,
    defaults: Defaults,
    spawner: Spawner,
) -> Arc<dyn connection::Service> {
    let server = Arc::new(server::Server::new(context, kernel, spawner, defaults));
    Arc::new(server::Handler(server))
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
