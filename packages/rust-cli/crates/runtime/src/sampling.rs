//! Fork: an MCP App panel's model sampling (specs/fork-rust-node-helper.md F3, `helper/sampleModel`). The frontend
//! opens the session first; the session runs the call on its model in the caller's task.

use rust_cli_kernel_api::sampling::{SamplingCall, SamplingError, SamplingReply};
use rust_cli_kernel_api::session_api::KernelError;

use super::LocalKernel;

impl LocalKernel {
    pub(crate) async fn sample(&self, call: SamplingCall) -> Result<SamplingReply, SamplingError> {
        let Some(session) = self.settled(&call.session).await else {
            return Err(KernelError::NotFound {
                session: call.session,
            }
            .into());
        };
        session.sample_model(call.request, call.cancel).await
    }
}
