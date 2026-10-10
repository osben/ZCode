// ============================================================
// Tools Index - Core tool definitions
// ============================================================

// Re-export all tool types
export * from "./contract.js";
export * from "./json-schema.js";
export * from "./read.js";
export * from "./write.js";
export * from "./edit.js";
export * from "./apply-patch.js";
export * from "./bash.js";
export * from "./node-repl.js";
export * from "./glob.js";
export * from "./grep.js";
export * from "./webfetch.js";
export * from "./agent.js";
export * from "./skill.js";
export * from "./todo.js";
export * from "./automation.js";
export * from "./off-peak.js";
export * from "./target.js";
export * from "./plan-mode.js";
export * from "./ask-user-question.js";
export * from "./send-message.js";
export * from "./respond-to-coordinator.js";
export * from "./task-output.js";
export * from "./task-stop.js";
export * from "./read-session-context.js";
export * from "./submit-result.js";
export * from "./websearch.js";
export * from "./workflow.js";
export * from "./create-workflow.js";
// Amendment entry point: the name constant is used by core dispatch, permission-service ownership
// rules, and bootstrap's actor denylist, as well as TUI/headless bypasses.
export * from "./amend-workflow.js";
export * from "./saved-workflow.js";
export * from "./save-workflow.js";
export * from "./list-saved-workflows.js";
// Discovery surface for dwf model selection: the name constant is used by core tool registration and
// bootstrap's actor denylist. Omitting this line would leave consumers without the schema and
// LIST_MODELS_TOOL_NAME.
export * from "./list-models.js";
export * from "./eval-workflow-snippet.js";
export * from "./list-workflow-runs.js";
export * from "./get-workflow-run.js";
// Resume entry point, grouped with the two introspection tools (run_id key and the same port-probe
// failure); omitting this line would leave consumers without the schema and
// RESUME_WORKFLOW_RUN_TOOL_NAME, silently breaking core's name-based dispatch.
export * from "./resume-workflow-run.js";
// Two tool surfaces for escalation Q&A: actor-side escalate and main-agent-side
// ResolveWorkflowQuestion. Core's allowlist restoration and bootstrap's actor denylist use these name
// constants; omitting either line silently breaks those paths (same rationale as resume-workflow-run).
export * from "./escalate.js";
export * from "./resolve-workflow-question.js";
export * from "./workflow-observation-display.js";
export * from "./tool-result-metadata.js";
export * from "./performance.js";

// Shared types (only once to avoid duplicates)
export type { DiffHunk, GitDiff } from "./write.js";
