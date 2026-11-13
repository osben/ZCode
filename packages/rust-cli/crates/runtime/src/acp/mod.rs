//! Fork: ACP external agents as the model of a session (specs/fork-rust-agent-parity.md "ACP external agents").
//! [`ExternalAgentRunner`] wraps the main query loop: a turn whose selection is an `acp:<agentId>` provider runs on
//! the agent process instead of a model request; every other turn goes to the loop unchanged.

mod guard;
mod pool;
mod records;
mod turn;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::clock::Ids;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ApiMessage, ModelSelection};
use rust_cli_kernel_api::orchestration::{
    QueryError, QueryRequest, QueryRunner, QueryStop, RunSink,
};
use rust_cli_kernel_api::store::Store;
use rust_cli_proc::ledger::Ledger;

pub(crate) use guard::ExternalAgentModelGuard;
pub(crate) use pool::AcpPool;
use records::AgentRecords;

/// The provider prefix of an ACP agent selection (Node `ACP_PROVIDER_ID_PREFIX`).
pub const ACP_PROVIDER_PREFIX: &str = "acp:";

/// The agent id of an ACP selection.
pub fn external_agent(selection: &ModelSelection) -> Option<&str> {
    selection.external_agent()
}

/// What the entry gives the runtime to run ACP agents: where the Host keeps the agent records, the raw process
/// environment the agent inherits (filtered by the launch rules), and the process ledger.
#[derive(Clone)]
pub struct AcpSetup {
    /// `fork_acp_agents.json` next to `provider_config.json`.
    pub records_file: PathBuf,
    pub env: Arc<[(String, String)]>,
    pub ledger: Ledger,
}

/// The ACP side of the app: the agent records and the resident runtimes.
pub(crate) struct AcpHost {
    records: AgentRecords,
    pub(crate) pool: AcpPool,
    ids: Arc<dyn Ids>,
}

impl AcpHost {
    pub(crate) fn new(setup: AcpSetup, store: Arc<dyn Store>, ids: Arc<dyn Ids>) -> Self {
        Self {
            records: AgentRecords {
                file: setup.records_file,
            },
            pool: AcpPool::new(setup.env, setup.ledger, store),
            ids,
        }
    }
}

/// The session close step of the ACP side (the closer's `released` is synchronous): the pool slot is taken at once,
/// the agent process stops in a task of the kernel scope.
#[derive(Clone)]
pub(crate) struct AcpRelease {
    pub(crate) host: Arc<AcpHost>,
    pub(crate) spawner: Spawner,
}

impl AcpRelease {
    pub(crate) fn released(&self, session: &SessionId) {
        let stopping = self.host.pool.release(session);
        drop(self.spawner.spawn("acp-release", stopping));
    }
}

/// The main runner: ACP selections run on the agent, the rest on the query loop.
pub(crate) struct ExternalAgentRunner {
    pub(crate) inner: Arc<dyn QueryRunner>,
    pub(crate) host: Arc<AcpHost>,
}

#[async_trait]
impl QueryRunner for ExternalAgentRunner {
    async fn run(
        &self,
        request: QueryRequest,
        sink: Arc<dyn RunSink>,
        abort: Abort,
    ) -> Result<QueryStop, QueryError> {
        match external_agent(&request.selection) {
            Some(agent_id) => {
                // Node `externalAgentTurnRefusal`: the turns the session opens by itself need a ZCode model.
                if let Some(what) = rust_cli_session::automatic_turn_subject(&request.messages) {
                    return Ok(QueryStop::ApiError {
                        message: format!(
                            "ACP agent {agent_id} runs only interactive chat turns; {what} need a ZCode model. Switch the model to continue."
                        ),
                    });
                }
                let agent_id = agent_id.to_owned();
                turn::run(&self.host, agent_id, request, sink, abort).await
            }
            None => self.inner.run(request, sink, abort).await,
        }
    }

    fn transcript(
        &self,
        history: &[Message],
        selection: &ModelSelection,
        mid_system: Option<bool>,
    ) -> Vec<ApiMessage> {
        self.inner.transcript(history, selection, mid_system)
    }
}
