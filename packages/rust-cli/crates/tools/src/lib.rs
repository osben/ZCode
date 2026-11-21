//! 工具注册、执行管线与内置工具（docs/specs/rust-cli/README.md §3、§6 规则 2）。
//!
//! - 注册：内置工具 + MCP + 插件，按名字与别名查找；
//! - 管线：validate → PreToolUse → 权限判决链 → call → PostToolUse / PostToolUseFailure；
//!   结果超过预算时落盘为 Artifact，只把预览交给模型（[`budget`]）；
//! - 内置工具：一个工具一个模块。文件与搜索（Read、Write、Edit、Glob、Grep、NotebookEdit）已实现，
//!   见 docs/specs/rust-cli/tools-files.md；Bash 见 docs/specs/rust-cli/shell-permissions.md；
//!   AskUserQuestion、计划模式、ToolSearch 与 Web 工具、Cron、Worktree、ReportFindings 见
//!   docs/specs/rust-cli/tools-more.md。
//!
//! 工具只做语义，IO 都经 `ToolUseContext::env`；readFileState 以会话为键（[`file_state`]）。

mod ask_user_question;
mod asking;
// Fork: Node `isWorkspaceMutatingToolCall` (2c-4e), the predicate behind the workflow's first-write import close.
mod automation_tools;
mod base64;
mod bash;
mod bash_mode;
pub mod bash_output;
mod bash_preview;
mod bash_reads;
mod bash_settings;
mod bash_sleep;
mod bash_timeouts;
pub mod budget;
mod changes;
mod checkpoint;
mod common;
mod cron_board;
mod cron_durable;
mod cron_expr;
mod cron_list;
mod cron_loop;
mod cron_resume;
mod cron_texts;
mod cron_tools;
mod cron_wakeups;
mod edit;
mod edit_input;
mod edit_match;
mod encoding;
pub mod file_state;
mod file_state_restore;
mod glob;
mod grep;
mod grep_output;
mod html_markdown;
mod line_diff;
mod lsp_range;
#[cfg(test)]
#[path = "side_effect_tests.rs"]
mod side_effect_tests;
mod workflow_tools;
// Fork: saved workflows (SaveWorkflow, ListSavedWorkflows; W7-8b).
mod saved_workflow;
mod workflow_list;
mod workflow_save;
// Fork: the containment check for a path the model names (SaveWorkflow and CreateWorkflow).
mod workspace_path;
// Fork (9.61): the `create_workflow` result card the three launch tools share.
mod workflow_card;
// Fork: CreateWorkflow (W7-8a).
mod workflow_create;
/// Fork (W9a, 9.53): the hub's saved-start resolution (Node `startSavedWorkflowRun` steps 1 and 2).
pub mod workflow_start;
// Fork: AmendWorkflow (W7-10, specs/fork-rust-workflow-engine.md, 9.43).
mod workflow_amend;
// Fork: FillWorkflowHole (W7-12, specs/fork-rust-workflow-engine.md, 9.45).
mod workflow_fill_hole;
// Fork: EvalWorkflowSnippet (W7-8c, specs/fork-rust-workflow-engine.md, 9.28).
mod workflow_eval_snippet;
// Fork: ListWorkflowRuns, ResumeWorkflowRun and ResolveWorkflowQuestion (W7-9, specs/fork-rust-workflow-engine.md, 9.40).
mod workflow_run_tools;
// Fork: GetWorkflowRun's model text (W7-9b, specs/fork-rust-workflow-engine.md, 9.42).
mod workflow_observation_display;
mod workflow_run_detail;
// Fork: the `LSP` agent tool (specs/fork-rust-lsp.md "Tool (D2)").
mod lsp_tool;
mod mentions;
mod monitor;
mod monitor_input;
mod notebook;
mod notebook_edit;
mod off_peak_tools;
#[cfg(test)]
#[path = "permission_subject_tests.rs"]
mod permission_subject_tests;
mod pipeline;
mod pipeline_hooks;
mod pipeline_machine;
mod plan_mode;
mod policy_filter;
mod read;
// Fork: specs/fork-rust-topic-resource.md.
mod read_pdf;
mod read_support;
mod read_topic_resource;
mod registry;
mod report_findings;
mod schedule_wakeup;
mod session_slug;
#[cfg(test)]
mod test_more;
mod texts;
mod texts_more;
mod tool_search;
mod tool_search_keywords;
mod tool_search_mcp;
mod user_input;
mod validate;
mod web_cache;
mod web_fetch;
mod web_search;
mod web_side;
mod web_texts;
mod worktree;
mod worktree_exit;
mod worktree_texts;
mod write;

use std::sync::Arc;

use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::orchestration::PermissionGate;
use rust_cli_kernel_api::tool::Tool;

pub use ask_user_question::AskUserQuestionTool;
pub use automation_tools::automation_tools;
pub use bash::BashTool;
pub use bash_settings::BashSettings;
pub use bash_timeouts::BashTimeouts;
pub use changes::FileChanges;
pub use common::FileTools;
pub use cron_board::CronBoard;
pub use cron_tools::cron_tools;
pub use edit::EditTool;
pub use file_state::ReadFileState;
pub use file_state_restore::restore_file_state;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use lsp_tool::{LspTool, LspTools};
pub use monitor::MonitorTool;
pub use notebook_edit::NotebookEditTool;
pub use off_peak_tools::off_peak_tools;
pub use pipeline::Pipeline;
pub use plan_mode::{EnterPlanModeTool, ExitPlanModeTool};
pub use policy_filter::PolicyFiltered;
pub use read::ReadTool;
pub use read_topic_resource::ReadTopicResourceTool;
pub use registry::BuiltinTools;
pub use report_findings::ReportFindingsTool;
pub use schedule_wakeup::ScheduleWakeupTool;
pub use tool_search::{ToolCatalog, ToolSearchTool};
pub use user_input::UserInputTools;
pub use web_fetch::{SideModel, WebFetchTool};
pub use web_search::WebSearchTool;
pub use workflow_create::describe_script_path;
pub use workflow_run_detail::provider_stop_text;
pub use workflow_run_tools::run_tools as workflow_run_tools;
pub use workflow_tools::{
    contracts as workflow_tool_contracts, is_amend_workflow_owned_predecessor,
    is_fill_workflow_hole_owned_run, workflow_tools,
};
pub use worktree::{WorktreeBoard, worktree_tools};
pub use write::WriteTool;

/// 文件与搜索工具，顺序固定（Glob、Grep 在 Read 之前）。
pub fn file_tools(files: &FileTools) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(GlobTool::new()),
        Arc::new(GrepTool::new()),
        Arc::new(ReadTool::new(files.clone())),
        Arc::new(EditTool::new(files.clone())),
        Arc::new(WriteTool::new(files.clone())),
        Arc::new(NotebookEditTool::new(files.clone())),
    ]
}

/// 交互、计划模式与 ToolSearch（docs/specs/rust-cli/tools-more.md）。`interactive` 为假（`-p`）时
/// AskUserQuestion 与计划模式的两个工具不可用（非交互会话里不提供它们）；`catalog` 由 runtime
/// 在主线程注册表建好后绑定，同时作为 `deferred_tools_delta` 的清单来源。
/// `ids` names the message ExitPlanMode adds for plan feedback.
pub fn interaction_tools(
    catalog: &Arc<ToolCatalog>,
    interactive: bool,
    ids: Arc<dyn rust_cli_kernel_api::clock::Ids>,
) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(AskUserQuestionTool::new(interactive)),
        Arc::new(EnterPlanModeTool::new(interactive)),
        Arc::new(ExitPlanModeTool::new(interactive, ids)),
        Arc::new(ToolSearchTool::new(catalog.clone())),
    ]
}

/// Web 工具（docs/specs/rust-cli/tools-more.md §4、§5）：WebFetch 与 WebSearch 的旁路模型请求用 `side`；
/// WebFetch 的页面缓存按 `clock` 过期。
pub fn web_tools(side: SideModel, clock: Arc<dyn Clock>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(WebFetchTool::new(Some(side.clone()), clock)),
        Arc::new(WebSearchTool::new(side)),
    ]
}

/// 内置工具集：文件与搜索工具共用一份 readFileState。`gate` 用于判断写入会不会被直接放行
/// （Edit / Write 的先读规则，tools-files.md §1.2），应与执行管线用同一套判决。
pub fn builtin(gate: Arc<dyn PermissionGate>) -> BuiltinTools {
    builtin_with(gate, None)
}

/// 同 [`builtin`]，另给 Read 查模型能力用的模型端口（整读 PDF 前看 `supports_pdf`，tools-files.md §1.5）。
pub fn builtin_with(gate: Arc<dyn PermissionGate>, model: Option<SideModel>) -> BuiltinTools {
    builtin_with_code(gate, model, None)
}

/// Fork: [`builtin_with`] plus the language-server runtime the file tools report to (specs/fork-rust-lsp.md).
pub fn builtin_with_code(
    gate: Arc<dyn PermissionGate>,
    model: Option<SideModel>,
    code: Option<Arc<dyn rust_cli_kernel_api::lsp::CodeIntelligence>>,
) -> BuiltinTools {
    let (files, state) = builtin_files(gate, model, code);
    BuiltinTools::new(file_tools(&files)).with_file_state(state)
}

/// Fork (node_desktop): [`builtin_with_code`] plus Node's Read partial view of a whole-file read over the token cap
/// (`FileTools::with_node_read`); `ids` names the `read_truncation_notice` attachment.
pub fn builtin_with_node_read(
    gate: Arc<dyn PermissionGate>,
    model: Option<SideModel>,
    code: Option<Arc<dyn rust_cli_kernel_api::lsp::CodeIntelligence>>,
    ids: Arc<dyn rust_cli_kernel_api::clock::Ids>,
) -> BuiltinTools {
    let (files, state) = builtin_files(gate, model, code);
    let files = files.with_node_read(ids);
    BuiltinTools::new(file_tools(&files)).with_file_state(state)
}

fn builtin_files(
    gate: Arc<dyn PermissionGate>,
    model: Option<SideModel>,
    code: Option<Arc<dyn rust_cli_kernel_api::lsp::CodeIntelligence>>,
) -> (FileTools, Arc<ReadFileState>) {
    let state = Arc::new(ReadFileState::default());
    let mut files = FileTools::new(state.clone(), gate);
    if let Some(model) = model {
        files = files.with_model(model);
    }
    if let Some(code) = code {
        files = files.with_code_intelligence(code);
    }
    (files, state)
}
