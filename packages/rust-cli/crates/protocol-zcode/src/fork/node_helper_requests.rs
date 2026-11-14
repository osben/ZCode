//! Fork: the helper's requests to Rust (specs/fork-rust-node-helper.md F3, "Helper → Rust requests"). Each carries a
//! `requestKey`; `helper/cancelRequest {requestKey}` abandons one, and Rust drops its work for that key (a pending
//! prompt is withdrawn). A cancel can overtake its request (`serve` runs each in its own task), so a key cancelled
//! before its request began is remembered (a bounded tombstone list) and the request starts cancelled. A helper that
//! exits abandons all of its generation's requests.

use std::collections::{HashMap, VecDeque};
use std::sync::Weak;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{NodeHelper, unavailable};

pub(crate) const AUTHORIZE_APP_TOOL: &str = "helper/authorizeAppTool";
pub(super) const CANCEL_REQUEST: &str = "helper/cancelRequest";

/// Cancels remembered for requests that have not begun yet.
const TOMBSTONES: usize = 256;

/// What answers the helper's requests: the protocol server, installed once it is built.
#[async_trait]
pub(crate) trait HelperRequests: Send + Sync {
    /// `helper/authorizeAppTool`; `cancel` fires when the helper abandons it.
    async fn authorize_app_tool(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError>;

    /// `helper/session/delta`: a live plugin UI delta for `session`'s stream (one of Node's four `pluginUi.*` ops).
    /// Called in the helper connection's read loop, so it must not block.
    fn session_delta(&self, session: &str, delta: Value);
}

#[derive(Default)]
pub(super) struct Requests {
    answers: Option<Weak<dyn HelperRequests>>,
    /// Running requests by key, with the generation that sent them.
    pub(super) live: HashMap<String, (u64, CancellationToken)>,
    cancelled: VecDeque<String>,
}

impl NodeHelper {
    pub(crate) fn set_requests(&self, answers: Weak<dyn HelperRequests>) {
        self.requests.lock_unpoisoned().answers = Some(answers);
    }

    /// A request of `generation`'s process.
    pub(super) async fn helper_request(
        &self,
        generation: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        if method != AUTHORIZE_APP_TOOL {
            return Err(RpcError::method_not_found(method));
        }
        let Some(key) = params
            .get("requestKey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
        else {
            return Err(RpcError::invalid_params("requestKey is required"));
        };
        let Some(answers) = self.answers() else {
            return Err(unavailable("the agent does not answer helper requests yet"));
        };
        let cancel = self.begin(generation, &key);
        let result = answers.authorize_app_tool(params, cancel).await;
        self.requests.lock_unpoisoned().live.remove(&key);
        result
    }

    pub(super) fn answers(&self) -> Option<std::sync::Arc<dyn HelperRequests>> {
        self.requests
            .lock_unpoisoned()
            .answers
            .as_ref()
            .and_then(Weak::upgrade)
    }

    /// The request's cancel. It starts cancelled when its cancel came first, or when its process is already gone:
    /// `serve` spawns the request, so the link can drop before it begins, after [`Self::requests_lost`] ran.
    fn begin(&self, generation: u64, key: &str) -> CancellationToken {
        let cancel = CancellationToken::new();
        let mut requests = self.requests.lock_unpoisoned();
        if let Some(position) = requests.cancelled.iter().position(|known| known == key) {
            requests.cancelled.remove(position);
            cancel.cancel();
        }
        if !self.with_running(generation, |_| ()) {
            cancel.cancel();
        }
        requests
            .live
            .insert(key.to_owned(), (generation, cancel.clone()));
        cancel
    }

    /// `helper/cancelRequest {requestKey}`.
    pub(super) fn cancel_request(&self, params: &Value) {
        let Some(key) = params.get("requestKey").and_then(Value::as_str) else {
            return;
        };
        let mut requests = self.requests.lock_unpoisoned();
        match requests.live.get(key) {
            Some((_, cancel)) => cancel.cancel(),
            None => {
                if requests.cancelled.len() == TOMBSTONES {
                    requests.cancelled.pop_front();
                }
                requests.cancelled.push_back(key.to_owned());
            }
        }
    }

    /// `generation`'s process is gone: nobody waits for its requests' answers.
    pub(super) fn requests_lost(&self, generation: u64) {
        let requests = self.requests.lock_unpoisoned();
        for (sent_by, cancel) in requests.live.values() {
            if *sent_by == generation {
                cancel.cancel();
            }
        }
    }
}
