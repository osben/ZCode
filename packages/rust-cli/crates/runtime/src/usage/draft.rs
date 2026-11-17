//! The draft preview of the context composition (Node `runtime/context-composition/preview.ts`, spec "Rust port", step
//! 1): the next request for a model, built the way `/context` builds it, with no side effects. Nothing is committed,
//! the history is not written, and the context prefix the session holds is not replaced (`analysis` builds its own).

use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::history;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource, SystemBlock, ToolDefinition};
use rust_cli_kernel_api::orchestration::ContextRequest;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_kernel_api::tool::PromptContext;
use rust_cli_kernel_api::tool_search::visible_tools;
use rust_cli_query::composition::{Breakdown, measure_parts};

use super::{UsageAnalyzer, failed, wire};

impl UsageAnalyzer {
    /// The composition of the next request for `selection`, sized the way the main loop would send it.
    pub(crate) async fn composition_draft(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        mode: PermissionMode,
        selection: &ModelSelection,
        history: &[Message],
    ) -> Result<Breakdown, KernelError> {
        let capabilities = self.model.capabilities(selection).await;
        let registered = self.tools.snapshot(session).tools;
        let tools = visible_tools(registered, capabilities.as_ref());
        let tool_names: Vec<String> = tools.iter().map(|tool| tool.name().to_owned()).collect();
        let prompt = PromptContext {
            tool_names: tool_names.clone(),
            mode,
        };
        let step = rust_cli_query::step_tool_search(
            &tools,
            &prompt,
            (self.tool_search, &selection.model, capabilities.as_ref()),
        );
        let request = ContextRequest {
            capabilities,
            tool_names,
            ..ContextRequest::new(
                session.clone(),
                workspace.clone(),
                QuerySource::MainThread,
                mode,
                selection.clone(),
            )
        };
        let analysis = self
            .context
            .analysis(&request, history)
            .await
            .map_err(failed)?;
        let active = history::active(history);
        let active: Vec<&Message> = active.iter().map(AsRef::as_ref).collect();
        let wired = wire(&tools, &active, mode, step.is_on());
        let system: Vec<SystemBlock> = analysis
            .sections
            .iter()
            .map(|section| SystemBlock {
                text: section.text.clone(),
                cache_control: None,
            })
            .collect();
        let mut tool_parts: Vec<(ToolDefinition, bool)> =
            wired.listed.into_iter().map(|tool| (tool, false)).collect();
        tool_parts.extend(wired.deferred.into_iter().map(|tool| (tool, true)));
        // An MCP tool is waiting (deferred) when it is not loaded yet.
        tool_parts.extend(wired.mcp.into_iter().map(|(tool, loaded)| (tool, !loaded)));
        Ok(measure_parts(
            &system,
            &active,
            &tool_parts,
            &selection.model,
            capabilities.map(|found| found.supports_mid_conversation_system),
        ))
    }
}
