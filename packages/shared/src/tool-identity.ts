export const ZCODE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  "Skill",
  "CreateWorkflow",
  // Revision entry point: register it in the workflow family to show the confirmation dialog.
  // Select the run confirmation block by family; tool rows first dispatch by name (resolveRenderer.ts), so the family fallback will not consume it.
  "AmendWorkflow",
  // Hole filling (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"): like
  // AmendWorkflow, register it in the workflow family so the confirmation dialog selects the run
  // confirmation block by family; tool rows first dispatch by name to the CreateWorkflow renderer
  // with hole-filling wording.
  "FillWorkflowHole",
  // The wire name is snake_case submit_result (the only one in the repository), so the underscore must be present literally:
  // If unregistered, UI identity falls back to unknown and Dynamic Workflow actor submissions use the raw fallback renderer.
  "submit_result",
] as const;

export type ZCodeKnownToolName = (typeof ZCODE_KNOWN_TOOL_NAMES)[number];

export type ZCodeToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "web-fetch"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "session-context"
  | "message"
  | "task-control"
  | "node-repl"
  | "workflow";

const TOOL_FAMILY_BY_NAME: Record<ZCodeKnownToolName, ZCodeToolFamily> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  WebFetch: "web-fetch",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  ReadSessionContext: "session-context",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // If TaskStop is unregistered, UI identity falls back to unknown and ultimately uses the raw fallback renderer.
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl is exposed through MCP, so its tool name in the UI has an MCP prefix.
  // If only the legacy built-in name is registered here, the dedicated REPL renderer falls back to unknown.
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  Skill: "skill",
  CreateWorkflow: "workflow",
  AmendWorkflow: "workflow",
  FillWorkflowHole: "workflow",
  submit_result: "workflow",
};

const TOOL_NAME_BY_LOWER = new Map<string, ZCodeKnownToolName>(
  ZCODE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export function normalizeZCodeToolName(
  value: string | null | undefined,
): ZCodeKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return TOOL_NAME_BY_LOWER.get(normalized.toLowerCase()) ?? null;
}

export function getZCodeToolFamilyForName(
  value: string | null | undefined,
): ZCodeToolFamily | null {
  const toolName = normalizeZCodeToolName(value);
  return toolName ? TOOL_FAMILY_BY_NAME[toolName] : null;
}

export function isZCodeToolFamily(
  value: string | null | undefined,
  family: ZCodeToolFamily,
): boolean {
  return getZCodeToolFamilyForName(value) === family;
}

export function isZCodeFileContentWriteToolName(value: string | null | undefined): boolean {
  return normalizeZCodeToolName(value) === "Write";
}

export const ZCODE_ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const ZCODE_EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

/** Exact wire-name match, shared by the CLI projection, Host adapter and UI projection. */
export function isZCodeAskUserQuestionToolName(value: string | null | undefined): boolean {
  return value === ZCODE_ASK_USER_QUESTION_TOOL_NAME;
}

/** Exact wire-name match, shared by the CLI projection, Host adapter and UI projection. */
export function isZCodeExitPlanModeToolName(value: string | null | undefined): boolean {
  return value === ZCODE_EXIT_PLAN_MODE_TOOL_NAME;
}

/** Permissions answered through the user-input flow (questions and plan approval), not allow/deny. */
export function isZCodeUserInputBackedPermissionToolName(
  value: string | null | undefined,
): boolean {
  return isZCodeAskUserQuestionToolName(value) || isZCodeExitPlanModeToolName(value);
}
