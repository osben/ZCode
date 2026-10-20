import type { PluginUiToolBinding } from "@/plugin-ui/contract.js";
import type { ComponentType, ReactNode } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { countPatchFileDiffs } from "@/lib/patchDiffPreview.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";
import type { OpenPlanDetailSideTabRequest } from "@/lib/workspaceSidePane.js";
// Bugfix：这里曾写成类型位置的内联动态 import 写法（在 typeof 后跟圆括号包模块名）。
// TS 编译期会擦除它，但 share 闭包守卫（shareBuildBoundary.test）的动态 import 正则
// 不区分类型/值与注释，把它当成值导入后，整个 ToolCallBlocks.tsx 大桶（含 plugin-ui
// 桶 → services/provider）被误判进 web-share 闭包。顶层 import type 同样不产生运行时
// 边，且能被守卫正确跳过。注释里也不要出现该字面写法，正则同样会命中注释文本。
import type { ToolCallBlock } from "@/ToolCallBlocks.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function readUnifiedDiffField(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  return readStringField(value, ["unified_diff", "unifiedDiff", "patch", "diff"]);
}

export function normalizeSingleFilePatch(
  patch: string | undefined,
  fileLabel: string,
): string | undefined {
  if (!patch) {
    return undefined;
  }

  const trimmedPatch = patch.trim();
  if (!trimmedPatch) {
    return undefined;
  }

  if (countPatchFileDiffs(trimmedPatch) > 1) {
    // When a sub-agent edits the same file again, the tool layer may return multiple diffs concatenated in one field.
    // PatchDiff can parse only single-file patches; rendering one directly throws and breaks “click the filename to view changes.”
    // Discard multi-file patches here so the caller falls back to a single-file diff from old/newText (or a file-content preview).
    return undefined;
  }

  if (/^---\s+/m.test(trimmedPatch) && /^\+\+\+\s+/m.test(trimmedPatch)) {
    return trimmedPatch;
  }

  if (trimmedPatch.startsWith("@@ ")) {
    const firstHeader = trimmedPatch.match(/^@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/m);
    const deletedCount = Number(firstHeader?.[2] ?? firstHeader?.[1] ?? "1");
    const addedCount = Number(firstHeader?.[4] ?? firstHeader?.[3] ?? "1");

    // The unified_diff returned by tools often contains only hunks, with no file headers.
    // For a new file, adding --- a/file would make PatchDiff parse it as a normal change, which can freeze the page for large additions.
    // Check the first hunk to detect a pure addition and use a /dev/null header instead.
    return [
      deletedCount === 0 && addedCount > 0 ? "--- /dev/null" : `--- a/${fileLabel}`,
      addedCount === 0 && deletedCount > 0 ? "+++ /dev/null" : `+++ b/${fileLabel}`,
      trimmedPatch,
    ].join("\n");
  }

  // Raw apply_patch content may also contain @@, but it is not a standard unified diff.
  // Do not add ---/+++ headers to it, or opening the file summary will send a malformed patch to PatchDiff.
  return trimmedPatch;
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // The ZCode protocol schema puts tool arguments for permission/request payloads in input.
  // The old UI read only the compatibility field rawInput, causing Write/Edit to display the full JSON instead of a file diff.
  return "input" in raw ? raw.input : null;
}

export function readStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isPlainRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function readRawToolCallChanges(raw: unknown) {
  if (!isPlainRecord(raw)) {
    return {
      directChanges: null,
      rawInputChanges: null,
      rawOutputChanges: null,
    };
  }

  const rawInputSource = readRawToolCallInput(raw);
  const rawInput = isPlainRecord(rawInputSource) ? rawInputSource : null;
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;

  return {
    directChanges: isPlainRecord(raw.changes) ? raw.changes : null,
    rawInputChanges: rawInput && isPlainRecord(rawInput.changes) ? rawInput.changes : null,
    rawOutputChanges: rawOutput && isPlainRecord(rawOutput.changes) ? rawOutput.changes : null,
  };
}

export interface RawToolCallFileSummary {
  path: string;
  actionLabel: "Created" | "Edited" | "Deleted";
  operationKind: EditOperationKind;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  changeStat?: { added: number; removed: number };
  patch?: string | null;
}

/**
 * All workflow-run facts needed to render a run-state tool card in chat. The host computes them while joining the `workflowRuns` projection by `toolCallId`.
 *
 * Intentionally limited to these four fields: the card provides **an entry point and summary**; budgets, event logs, results, and failure panels belong to the detail page.
 */
export interface WorkflowRunCardSummary {
  runId: string;
  /**
   * ID of the **CreateWorkflow row** that started this run (projection `run.toolCallId`). Requests to open the side-pane
   * run view must include it—`WorkflowRunSidePane` uses this ID to find the initiating row in the row window (both causalityGraph
   * and the original script are attached to that row). Populate it only in the byRunId join table (the byToolCallId table key is this value);
   * the resume row's own toolCallId is **not** this value (the resume row's display has no graph).
   */
  toolCallId?: string;
  status: WorkflowRunState["status"];
  /** Reason for `stopped`; included only when present in the projection. */
  stopReason?: WorkflowRunState["stopReason"];
  /** Number of settled nodes (`phase === "settled"`), **including** those omitted from the table after reaching its limit. */
  nodesSettled: number;
  /**
   * Number of scheduled (observed) nodes, **not** the total for the run—dynamic workflow node counts are determined
   * by the script at runtime, so no static total exists. Read progress as “how many of the scheduled nodes have settled,” never as a completion percentage.
   *
   * Both counts come from `workflowRunStepCounts` (@zcode/shared): `nodes` in the table + `usage.nodesUnlisted`
   * outside it. A run that exceeds the 1024-node limit still reports its true step count here; what is omitted is **per-step detail**.
   * The card and detail page each explain this with “Details shown for n/m steps only”.
   */
  nodesTotal: number;
  /**
   * Number of sub-agents (projection `run.actors.length`). The card count includes only phases and sub-agents.
   *
   * Still optional: both join-table builders always populate it, but the type does not require it. After cold replay landed,
   * the two journal-fallback merges were removed, leaving no second producer today; consumers remain tolerant of absence and omit the count.
   */
  agents?: number;
  /**
   * This run from the live projection, used by the card to build the timeline model (lights, pills, and ink).
   * Absent for journal-fallback matches; those have only a status label and render a static timeline.
   */
  run?: WorkflowRunState;
  /**
   * Whether it can resume (live projection `cancelled`, or `resumable` computed from the CLI resume gate in the journal summary).
   * Render Resume in the card footer only when this is present; the UI must never derive it from status + failureCode.
   */
  resumable?: true;
}

/**
 * Position of a CreateWorkflow/AmendWorkflow row in the compile-feedback loop. The host computes it in one pass over row order (`v4/workflowDraftJoin.ts`); the renderer is read-only.
 */
export interface WorkflowDraftPosition {
  /** Draft number: the submission count since the last compile in the same lineage and turn, starting at 1. */
  ordinal: number;
  /** Whether a later row exists in the same lineage; the feedback row's hollow-circle indicator fades from warning to neutral. */
  superseded: boolean;
}

export interface ToolCallBlockRenderContext {
  nestedToolRenderer: ComponentType<Parameters<typeof ToolCallBlock>[0]>;
  isOfficeMode?: boolean;
  toolCallNode: TaskChatToolCallTreeNode;
  workspacePath: string;
  /**
   * Plugin UI: scope is the session scope required for sandbox registration; onOpenSidePane is the
   * “open in side pane” callback. Both are injected at the boundary by PluginUiSessionProvider.
   * When absent, the host does not provide them, and tools with ui:// resources fall back to regular MCP cards.
   */
  pluginUi?: PluginUiToolBinding;
  /**
   * App theme (store coupling removed): passed from higher-level state by the host building render context
   * (ToolCallBlock / PermissionDialog, etc.) so display components such as MessageResponse / EditInlineDiffContent
   * can select light/dark styling. Display components fall back to "system" when omitted.
   */
  theme?: Theme;
  /** Code-preview settings (store coupling removed): same as above, passed by the host with a stable reference. */
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  isRunning: boolean;
  /** Permission preview has not executed; show neither output nor an empty-output placeholder. */
  isPermissionPreview?: boolean;
  statusLabel: string;
  sourceLabel?: string;
  errorText?: string;
  childToolList: ReactNode;
  showIcon?: boolean;
  /** Explicitly enlarge the App Icon for CUA Group children; standalone CUA keeps the default size. */
  cuaAppIconClassName?: "size-4" | "size-5";
  kindLabelOverride?: ReactNode;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  /** Changes children may mount after a diff already exists; animate the initial count as it enters too. */
  animateDiffCountOnMount?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  /**
   * Read-only observation entry point for a v4 subagent child session. Agent renderers turn the summary row into
   * an action that opens a right-side tab directly; non-Agent tools ignore it.
   */
  agentSummaryAction?: {
    onActivate: () => void;
    testId?: string;
  };
  /** Live, provider-reported token usage and elapsed time for a paired subagent row. */
  agentUsageSummary?: ReactNode;
  agentUsageSummaryVersion?: string;
  /** Runtime-authoritative type from a paired v4 subagentRow projection; preferred while streaming input is incomplete. */
  authoritativeAgentType?: string;
  /** ExitPlanMode plan card: open the Side Pane after the conversation host binds the parent/session scope. */
  onOpenPlanDetail?: (request: Omit<OpenPlanDetailSideTabRequest, "parentSessionId">) => void;
  /**
   * Entry point for CreateWorkflow run details.
   *
   * The card provides only the display name—`toolCallId`, `runId`, and conversation identity are all bound by the host. **Its presence is itself the gate**:
   * the host injects it only when this tool call has an openable run (run identity comes from the `workflowRuns` projection;
   * see the `workflowRunSchema.toolCallId` comment: it is the “tool card → detail page join key”).
   * Intentionally do not read `backgroundTaskId` from tool output: a v4 row's `output.text` contains only the `response` prose
   * selected by `formatCreateWorkflowModelContent`; structured fields are not on the row.
   */
  onOpenWorkflowRun?: (request: { workflowName?: string; phaseId?: string }) => void;
  /**
   * Resume action in the card footer: uses the same v4 `resumeWorkflowRun {workId}` command as the detail page,
   * with runId and conversation bound by the host. Omission means no button is rendered.
   */
  onResumeWorkflowRun?: (request: { workflowName?: string }) => void;
  /**
   * Clicking a sub-agent pill opens its transcript directly. The card provides slot identity (run, station, ordinal, runtime name, and session ID when available;
   * an unstarted pill can also open a placeholder tab); the host binds conversation and workspace identity. Omission means the pill is not clickable.
   */
  onOpenWorkflowActor?: (request: {
    runId: string;
    actorSessionId?: string;
    siteId: string;
    ordinal: number;
    actorName?: string;
  }) => void;
  /**
   * Script pill → script-transcript tab: the card provides only this station's phase ID (destination) and display name;
   * the host binds the run, initiating row, and conversation identity (same as `onOpenWorkflowRun`). Omission means the script pill is not clickable.
   */
  onOpenWorkflowWorkspace?: (request: { phaseId: string; workflowName?: string }) => void;
  /**
   * Artifact pill in the timeline → artifact tab:
   * the card provides only the artifact ID; the host binds run and conversation identity. Omission disables the pill.
   */
  onOpenWorkflowArtifact?: (artifactId: string) => void;
  /**
   * Summary of the workflow run joined to this tool call; when present, the card enters run state (a compact clickable card).
   *
   * The card does not inspect the `workflowRuns` projection itself: the host computes the join (by `toolCallId`) and counts once
   * (`workflowRunCardJoin.ts`), and the renderer is read-only. `nodesTotal` is the number of **scheduled** (observed) nodes—
   * dynamic workflows have no static total, so progress means “how many scheduled nodes have settled,” not the percentage of the full run.
   */
  workflowRun?: WorkflowRunCardSummary;
  /**
   * Draft position for this tool call. If omitted (the host has no row window, as in a read-only share), the card has no number and keeps the warning-colored indicator.
   * Like `workflowRun`, do not forward it to child tool cards: position is joined by toolCallId, and forwarding would give another row this row's draft number.
   */
  workflowDraft?: WorkflowDraftPosition;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Scheduled-task tool card navigation to the management page; open details directly when automationId is present. */
  onOpenAutomationsMain?: (automationId?: string) => void;
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
}

export interface EditKindSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

export type EditOperationKind = "write" | "edit" | "update" | "delete";
export type EditKindLabelId =
  | "chat.toolCall.edit.writing"
  | "chat.toolCall.edit.updating"
  | "chat.toolCall.edit.deleting"
  | "chat.toolCall.edit.editing"
  | "chat.toolCall.kind.write"
  | "chat.toolCall.kind.delete"
  | "chat.toolCall.kind.edit";
