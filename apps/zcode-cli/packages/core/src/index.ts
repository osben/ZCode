// ============================================================
// Core package exports
// ============================================================

// Agent components
export * from "./agent/index.js";

// Context Builder
export * from "./context/index.js";

// Compact helpers
export * from "./compact/index.js";

// Memory paths
export { resolveProjectMemoryRoot } from "./memory/project-root.js";

// Tool components
export { ToolScheduler, defaultToolScheduler, READ_ONLY_TOOLS } from "./tool/scheduler.js";
export type { ToolSchedule, ToolScheduleItem, ToolDependency } from "./tool/scheduler.js";
export { createToolRegistry, ToolRegistry, ToolRegistryImpl } from "./tool/registry.js";
export { createToolExecutor, ToolExecutor, ToolExecutorImpl } from "./tool/executor.js";
export { builtInTools, registerBuiltInTools } from "./tool/handlers/index.js";
// Language-server (LSP) service: bootstrap constructs one per workspace and passes it through AgentRuntimeDeps.lsp.
export {
  LspService,
  createLspService,
  createLspDocumentSync,
  LspServerRegistry,
} from "./lsp/index.js";
export type { LspDocumentSync } from "./lsp/index.js";
export type {
  LspServiceOptions,
  LspQueryContext,
  EditDiagnosticsRequest,
  EditDiagnosticsResult,
  LspServerMatch,
} from "./lsp/index.js";
// The DWF driver's submit-profile runtime guard converts the typed declaration back to a generic declaration.
export {
  createSubmitResultToolEntry,
  submitResultToolEntry,
} from "./tool/handlers/submit-result.js";
// Store/codec for saved workflows: the GUI hub's protocol handler lives in
// bootstrap, but there must be only one parser and serializer. If the read and write sides evolve separately, a newly saved workflow
// may not appear in the list, so export these here instead of duplicating them in bootstrap.
export {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  moveSavedWorkflow,
  parseSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowFileName,
  savedWorkflowPath,
  savedWorkflowRoot,
  savedWorkflowRoots,
  serializeSavedWorkflow,
  validateWorkflowArgs,
} from "./tool/handlers/saved-workflows/index.js";
// Use the same type checker (docs/dynamic-workflow/launch.md, “`SaveWorkflow`”) when the GUI saves directly from a run—
// “it saves but cannot run” is one of the hardest failures to explain, and compiling separately in the two entry points is a common cause.
export { analyzeScript } from "./tool/handlers/workflow-script-analysis.js";
// Keep draft naming rules in one place (docs/dynamic-workflow/launch.md, “The draft after a fill”): the bootstrap run
// service receives this through injection and uses it to create a draft when completing a run that was not saved as one at launch, rather than duplicating slug / `-2` / `wx` logic.
export {
  writeWorkflowDraft,
  type WriteWorkflowDraftInput,
} from "./tool/handlers/workflow-drafts.js";
export type {
  ResolvedSavedWorkflow,
  SavedWorkflowListResult,
  SavedWorkflowMoveResult,
  SavedWorkflowParseErrorReason,
  SavedWorkflowParseResult,
  SavedWorkflowResolveFailure,
  SavedWorkflowResolveResult,
  SavedWorkflowRoot,
  SavedWorkflowRootsOptions,
  WorkflowArgsValidation,
} from "./tool/handlers/saved-workflows/index.js";
export {
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  resolveBashTimeoutPolicy,
} from "./tool/bash-timeout-policy.js";
export type { BashTimeoutPolicy } from "./tool/bash-timeout-policy.js";
export type {
  ToolMetadata,
  ToolHandler,
  ToolExecutionContext,
  ToolEntry,
  ToolExecutionResult,
  ToolResultSerialization,
  ToolBatchResult,
  ExecutableToolCall,
  ToolBatchEvent,
} from "./tool/types.js";

// Hooks
export * from "./hooks/index.js";

// MCP components
export * from "./mcp/index.js";

// Plugin conversation references (@ Plugin capability hint)
export * from "./plugin-reference/index.js";

// Node REPL/browser-use plugin runtime primitives
export { NodeReplSession } from "./repl/node-repl-session.js";
export type {
  NodeReplCuaAppIdentity,
  NodeReplImage,
  NodeReplRequestMeta,
  NodeReplRunResult,
  NodeReplStructuredResult,
  NodeReplSessionOptions,
} from "./repl/node-repl-session.js";
export { setupBrowserRuntime } from "./browser-client/index.js";
export type { BrowserClientTransport } from "./browser-client/index.js";

// Subagent components
export * from "./subagent/index.js";

// Runtime task components
export * from "./runtime-task/index.js";

// Workflow components
export * from "./workflow/definition.js";
export * from "./workflow/expert.js";
export * from "./workflow/lifecycle.js";
export * from "./workflow/scheduler.js";

// Permission components
export {
  DenyPermissionBroker,
  ManualPermissionBroker,
  PermissionService,
  createDenyPermissionBroker,
  createManualPermissionBroker,
  defaultPermissionConfig,
} from "./permission/index.js";
export type {
  ManualPermissionBrokerOptions,
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission/index.js";
export type { PermissionConfig } from "./permission/index.js";

// Runtime
export { AgentRuntime } from "./runtime.js";
export {
  createExternalTurnFaultError,
  createTurnCancelReason,
  hasPreserveQueueAutoDrainCancelIntent,
} from "./runtime/helpers/turn-errors.js";
export { repairPersistedRemoteSessionPaths } from "./runtime/helpers/persisted-remote-session-path-repair.js";
// Shared with the CLI command-center so local usage replies match the runtime's wording.
export { DREAM_COMMAND_USAGE_RESPONSE } from "./runtime/methods/dream.js";
// Clone a transcript by value into another session. The second consumer besides fork is DWF amend-resume
// transcript truncation (bootstrap's workflow-actor-transcript.ts): both perform the same operation—continue with local IDs in the new session,
// remapping parentID and anchors embedded in parts. Export this instead of duplicating it because symptoms of a missed remap
// (a dangling parentID or an anchor pointing to the parent session) are far from the cause.
export { cloneMessageForFork, clonePartForFork } from "./runtime/helpers/steering.js";
export type {
  ChildClientPortsContext,
  ClientFacingPorts,
} from "./runtime/helpers/child-client-ports.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnResult,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
  RuntimeFactory,
} from "./runtime.js";

// Output helpers
export { color, formatJson, supportsColor } from "./output.js";

// Environment helpers
export { getRuntimeInfo } from "./environment.js";
export type { RuntimeInfo } from "./environment.js";

export type {
  Logger,
  LoggerFactory,
  LogContext,
  LogEntry,
  SessionEvent,
  SessionEventSink,
} from "@zcode/contracts";
export { LogLevel, SessionEventType } from "@zcode/contracts";
