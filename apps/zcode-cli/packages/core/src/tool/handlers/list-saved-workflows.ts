// ============================================================
// ListSavedWorkflows Tool Handler
// ============================================================
// List DWF definitions saved in this project (the session working directory).
//
// This is **different from** ListWorkflowRuns, and both descriptions must make that clear: the latter lists runs that already
// happened (history, stateful, with runId); this lists definitions available to run (catalog, stateless, with names). A common model
// mistake is to answer “what workflows are available?” with “which workflows have run?” and tell the user there are none even though
// the project contains five definitions.

import {
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsInputJsonSchema,
  ListSavedWorkflowsInputSchema,
  ListSavedWorkflowsOutputJsonSchema,
  ListSavedWorkflowsOutputSchema,
  SAVED_WORKFLOW_PROJECT_DIR,
  type ListSavedWorkflowsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { listSavedWorkflows } from "./saved-workflows/index.js";

const LIST_SAVED_WORKFLOWS_TIMEOUT_MS = 10_000;
/** As with ListWorkflowRuns, keep the catalog lightweight (answered by one directory scan); 24k is enough for dozens of entries with room to spare. */
const LIST_SAVED_WORKFLOWS_MODEL_BYTES = 24_000;

const LIST_SAVED_WORKFLOWS_DESCRIPTION = [
  `Lists the dynamic workflows saved in this project (\`${SAVED_WORKFLOW_PROJECT_DIR}/\`, keyed on the session's working directory) and the global archive (\`~/.zcode/workflows\`, available from every project). These are workflow DEFINITIONS you can run, not past runs — for the run history use ListWorkflowRuns instead.`,
  "",
  "- Each row gives the name, what the workflow does, when to reach for it, and the arguments it takes.",
  "- Run one by passing its name to CreateWorkflow as `saved: { name, args }`. The user still confirms the run.",
  "- Check here before writing a workflow from scratch: if the project already saved one that fits, running it beats rebuilding it.",
  "- `invalid` lists saved files that could not be read (usually a hand-edited metadata block). They are named so they can be fixed, not silently skipped.",
].join("\n");

const listSavedWorkflowsHandler: ToolHandler = async (input, context) => {
  ListSavedWorkflowsInputSchema.parse(input);

  // Always use this session's working directory: the model cannot scan other projects, which is also required by `sideEffectScope: "none"`.
  const { entries, invalid } = listSavedWorkflows({ cwd: context.workingDirectory ?? "." });

  return {
    workflows: entries,
    // Omit when empty; an empty array would add a noisy field to every call.
    ...(invalid.length > 0 ? { invalid } : {}),
  } satisfies ListSavedWorkflowsOutput;
};

/**
 * Model-facing format: one XML-ish container with one block per workflow.
 *
 * Intentionally differs from ListWorkflowRuns' **single-line** attribute format: runs are low-information, high-cardinality entities
 * (50 rows look alike, so one line of attributes works), while a saved workflow has a description, usage context, and argument table—
 * the information the model needs to **choose** a workflow. Compressing it to one line would hide that information. There are also far
 * fewer saved workflows (a few to dozens per project), so several lines per entry are practical.
 */
function formatListSavedWorkflowsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListSavedWorkflows returned an invalid result.";

  const { workflows, invalid } = parsed.data;

  if (workflows.length === 0 && invalid === undefined) {
    // Explicitly say when the project has no saved workflows; an empty container can look like the tool failed to answer.
    return [
      '<saved_workflows count="0">',
      `No workflows are saved in this project yet. Saved definitions live in ${SAVED_WORKFLOW_PROJECT_DIR}/.`,
      "</saved_workflows>",
    ].join("\n");
  }

  const blocks = workflows.map((workflow) => {
    const lines = [
      `<workflow name="${escapeAttribute(workflow.name)}" scope="${workflow.scope}">`,
      `  ${workflow.description}`,
    ];
    if (workflow.whenToUse !== undefined) lines.push(`  When to use: ${workflow.whenToUse}`);
    for (const [key, spec] of Object.entries(workflow.args ?? {})) {
      const notes = [
        spec.type,
        spec.required === true ? "required" : undefined,
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      const description = spec.description === undefined ? "" : ` — ${spec.description}`;
      lines.push(`  arg ${key} (${notes.join(", ")})${description}`);
    }
    lines.push("</workflow>");
    return lines.join("\n");
  });

  const invalidLines = (invalid ?? []).map(
    (entry) => `<invalid path="${escapeAttribute(entry.path)}">${entry.reason}</invalid>`,
  );

  return [
    `<saved_workflows count="${workflows.length}">`,
    ...blocks,
    ...invalidLines,
    "</saved_workflows>",
  ].join("\n");
}

/** Put name and path in attributes: both can contain quotes (especially paths), and unescaped text would produce malformed tags. */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export const listSavedWorkflowsToolEntry: ToolEntry = {
  capability: "List the reusable dynamic-workflow definitions saved in this project",
  metadata: {
    shouldDefer: true,
    name: LIST_SAVED_WORKFLOWS_TOOL_NAME,
    description: LIST_SAVED_WORKFLOWS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxOutputBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listSavedWorkflowsHandler,
  inputSchema: ListSavedWorkflowsInputJsonSchema,
  outputSchema: ListSavedWorkflowsOutputJsonSchema,
  runtimeInputSchema: ListSavedWorkflowsInputSchema,
  runtimeOutputSchema: ListSavedWorkflowsOutputSchema,
  formatModelContent: formatListSavedWorkflowsModelContent,
  permission: {
    permission: "listSavedWorkflows",
    reason: "ListSavedWorkflows reads the saved workflow definitions of the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // Input has no path subject (cwd comes from session context), so match only by tool name.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Intentionally **do not** inherit SaveWorkflow / CreateWorkflow's alwaysAsk: those gates exist for “writing to the user's
    // repository” and “executing a full code block,” neither of which applies to reading the catalog.
  },
  resultBudget: {
    maxInlineBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    maxModelBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ListSavedWorkflows scans the project's workflow directory synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
