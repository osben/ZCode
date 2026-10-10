/**
 * Name-based recognition for workflow-family tools, consolidating matching logic that was duplicated in three places:
 * - Reusable workflows: `SaveWorkflow` / `ListSavedWorkflows`;
 * - Escalation questions: `escalate` / `ResolveWorkflowQuestion`;
 * - Inspection and recovery: `GetWorkflowRun` / `ListWorkflowRuns` / `EvalWorkflowSnippet` and `ResumeWorkflowRun`;
 * - Model catalog: `ListModels`.
 *
 * Why not use `resolveToolCallIdentity`: these tool names are not in `packages/shared`'s
 * `ZCODE_KNOWN_TOOL_NAMES`, so identity would return `unknown` and routing would fall through to the raw JSON fallback card.
 *
 * These checks must also run **before** family routing: the `workflow` family's fallback branches are the CreateWorkflow
 * card (`resolveRenderer.ts`) and runtime confirmation block (`PermissionDialog.tsx`). If these names are registered
 * in the workflow family, save/list calls silently render as “Create workflow” — the save confirmation dialog would even show
 * a causal graph and Refine option. Checking names first keeps behavior correct both before and after registration.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  // Normalize like cron-create.tsx: remove case and separators so both wire forms, `SaveWorkflow` and `save_workflow`, match.
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface WorkflowToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: WorkflowToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isSaveWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "saveworkflow");
}

export function isListSavedWorkflowsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listsavedworkflows");
}

export function isEscalateToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "escalate");
}

export function isResolveWorkflowQuestionToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resolveworkflowquestion");
}

export function isGetWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "getworkflowrun");
}

export function isListWorkflowRunsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listworkflowruns");
}

export function isEvalWorkflowSnippetToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "evalworkflowsnippet");
}

export function isResumeWorkflowRunToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "resumeworkflowrun");
}

/**
 * Model catalog, using the same name-based check:
 * `ListModels` is also absent from the known tools table, so the fallback card would expose the model-facing text beginning with providerId verbatim.
 */
export function isListModelsToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "listmodels");
}

/**
 * Creation entry point. Rendering still routes through the `workflow` family (whose fallback is the create card); this name check is only for readers that bypass routing:
 * the compile-feedback revision link must recognize
 * every creation in the row window, while the family also includes revisions.
 */
export function isCreateWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "createworkflow");
}

/**
 * Revision entry point. It is **already registered** in the workflow
 * family (the confirmation dialog selects its runtime block by family), but tool rows still check by name first: the same create-workflow renderer uses
 * revision terminology instead of letting the family fallback draw a regular “Create workflow” card.
 */
export function isAmendWorkflowToolCall(source: WorkflowToolNameSource): boolean {
  return matchesToolName(source, "amendworkflow");
}
