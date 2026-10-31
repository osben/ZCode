/**
 * Serialization rules for workflow-run artifacts, shared by two places in core:
 * `<result>` in completion notifications (background-tasks.ts) and `resultText` on
 * runtime task entries (background-task-registry.ts, the sole source for TaskOutput).
 *
 * The implementation **moved to `@zcode/contracts`** (`interfaces/dynamic-workflow-run.port.ts`,
 * alongside `boundDynamicWorkflowRunEventPayload`) because it gained a third consumer:
 * the bootstrap v4 projection uses the same rule for `workflowRuns.reports[].preview`
 * in the detail page's Results section. Bootstrap cannot import core internals, and
 * duplicating serialization would make the same value look different in notifications
 * and the panel. Keep this re-export so the two core import sites do not change.
 */
import {
  serializeWorkflowArtifact,
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSnapshot,
  type ExecutionPort,
  type SubagentTaskSnapshot,
  type WorkflowTaskSnapshot,
  type WorkflowNotificationMeta,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import { isRecord } from "./utils.js";
import {
  buildWorkflowArtifactsManifestSection,
  toPublishedArtifactSummaries,
} from "./workflow-published-artifacts.js";

export { serializeWorkflowArtifact };

/**
 * Character budget for the `<reports>` section in completion notifications.
 *
 * Notifications already have a 120k overall truncation limit, but that is the **last** gate and truncates later fields first. Snapshots can contain
 * up to 256 progressive artifacts (`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`); expanding them without a local limit could push `<result>` and
 * `<error>` out of the notification, even though those are what the model needs first. So this section has its own budget.
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** Per-item limit: a 32 KB artifact should not consume the whole section budget and keep the next ten entries out. */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** **Actual total count** (not the number of previewed entries). */
  count: number;
  /** Number of entries actually included in the preview; less than count means the preview is partial. */
  shown: number;
  preview: string;
}

/**
 * Convert report entries from the journal into a `<reports>` section in completion
 * notifications (shared by completed / failed / cancelled states).
 *
 * Both truncation and count matter: count tells the main agent that the preview is
 * partial and the full set can be retrieved by run id. A preview alone could make the
 * model think it saw everything; a count alone would return no artifact content.
 *
 * `total` is the run's actual item count (snapshot `reportCount`); `items` contains only the first portion (snapshots are capped
 * at 256 items). Fall back to `items.length` when absent—older snapshots lack this field, and their `items` contain everything.
 *
 * Return `undefined` for zero entries so the caller omits the entire section instead of emitting an empty `<reports>`.
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
  total?: number,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // Include at least one entry: one oversized artifact is more useful than reporting eleven entries with none visible.
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    count: Math.max(total ?? 0, items.length),
    shown: lines.length,
    preview: lines.join("\n"),
  };
}

/**
 * Build the `<reports>` section in the manifest payload (`WorkflowNotificationMeta.reports`).
 * Like the **notification text** section above, it uses the same per-entry serializer
 * (`serializeWorkflowArtifact`), but returns **string[]** instead of joined text. The
 * GUI renders each manifest entry as a numbered preview; joining would force it to split
 * the text again.
 *
 * This has a deliberately different limit from the notification-text section: at most
 * 500 characters per entry and 8 entries (matching shared's
 * `workflowNotificationMetaSchema`; exceeding it makes zod reject the turnHeader row
 * when persisted). `count` is always the **actual total**: `count ≠ shown` signals that
 * the preview is partial and the full set is available by run id.
 *
 * `total` has the same meaning as in the notification section (snapshot `reportCount`, falling back to `items.length` when absent).
 *
 * Return `undefined` for zero entries so the caller omits the field entirely.
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
  total?: number,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(
      clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS),
    );
  }
  return { count: Math.max(total ?? 0, items.length), shown: preview.length, preview };
}

/** Per-entry artifact preview limit in the manifest payload (shared schema: ≤500 characters). */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** Maximum number of entries previewed in the manifest payload (shared schema: ≤8). */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Notification payloads and display summaries come from the same module; the tracker only observes and persists lifecycle events.
export type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // A workflow run snapshot keeps WorkflowTaskSnapshot's shape but widens output to unknown (the
  // artifact is whatever the script's top-level returns), so it is not a subtype of
  // WorkflowTaskSnapshot and must stand as its own branch.
  | DynamicWorkflowRunSnapshot;

export function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: "completed" | "failed" | "killed";
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // One sentence must say how it ended: the model reads the summary before any XML field. dwf's
  // three terminal words take precedence; legacy `Workflow` carries no runStatus and falls back to
  // the tracker's generic words.
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

type WorkflowTerminalRunStatus = "completed" | "errored" | "stopped";

/**
 * The three-terminal facts on a dwf snapshot. Only the dwf snapshot branch carries
 * `runStatus` / `stopReason` / `failure` (port contract `DynamicWorkflowRunSnapshot`); when an old
 * port or stub omits them, fold to the tracker's generic words: `failed` → errored, `cancelled` →
 * stopped (reason absent — the caller falls back to the registry). Non-terminal returns undefined.
 */
export function workflowSnapshotTerminal(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
):
  | {
      runStatus: WorkflowTerminalRunStatus;
      stopReason?: DynamicWorkflowRunStopReason;
      failure?: DynamicWorkflowRunError;
    }
  | undefined {
  const record = snapshot === undefined ? undefined : (snapshot as Record<string, unknown>);
  const declared = record?.runStatus;
  const runStatus: WorkflowTerminalRunStatus | undefined =
    declared === "completed" || declared === "errored" || declared === "stopped"
      ? declared
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "errored"
          : status === "cancelled"
            ? "stopped"
            : undefined;
  if (runStatus === undefined) return undefined;
  const reason = record?.stopReason;
  const stopReason =
    runStatus === "stopped" &&
    (reason === "user" ||
      reason === "model" ||
      reason === "provider" ||
      reason === "interrupted" ||
      reason === "superseded")
      ? reason
      : undefined;
  const failure = isRecord(record?.failure)
    ? (record?.failure as unknown as DynamicWorkflowRunError)
    : undefined;
  return {
    runStatus,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export function workflowTaskSubject(
  toolCall: ExecutableToolCall,
  taskId: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  return (
    stringField(input, "description") ??
    (snapshot && "description" in snapshot ? runtimeString(snapshot.description) : undefined) ??
    (snapshot && "name" in snapshot ? runtimeString(snapshot.name) : undefined) ??
    stringField(output, "name") ??
    stringField(input, "name") ??
    stringField(input, "scriptPath") ??
    taskId
  );
}

export function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Bounds for each field of the manifest payload (`WorkflowNotificationMeta`). The emitting side
 *  truncates in place — the payload travels via the turnHeader row over protocol + snapshot, shared's
 *  `workflowNotificationMetaSchema` enforces the same `.max()` set, and an over-bound value makes zod
 *  reject the whole row at persistence. Truncation is therefore a **pre-construction** discipline,
 *  not an optional afterthought. */
const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;
const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;
const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

/**
 * Workflow originMeta (with the manifest payload) for a workflow run's terminal notification. The
 * two entries, CreateWorkflow / ResumeWorkflowRun, are isomorphic and both mint through here: title
 * and summary share one source (`workflowTaskSubject`), and the payload is attached only at a
 * **terminal state with a snapshot present** (non-terminal / lost without a snapshot → the whole
 * field is absent and the GUI falls back to the bare title row).
 */
export function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/**
 * Snapshot-level facts → the manifest payload for the terminal discriminated branch.
 *
 * Minted only at the three terminal states (completed / failed / cancelled) with a snapshot
 * present. `lost` (missing snapshot) and non-terminal always return `undefined` — an absent payload
 * means the GUI falls back to the existing title row rather than lying with an empty shell.
 * **usage/tokens are unknowable at emit time** (they live only in the in-memory projection), so
 * only durationMs is carried; tokens are left for the GUI to look up by runId at render time.
 */
function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  // Artifact: the script's arbitrary top-level return value, serialized uniformly. Truncation is
  // honest — a present `resultTruncated` means the preview is partial, and the full value is
  // available via run id / GetWorkflowRun. resultForm mirrors serializeWorkflowArtifact's split:
  // string verbatim (prose), everything else JSON.stringify (json).
  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  // Progressive reports are always attached at all three terminal states: a run that dies on its 12th ask still did the work of 11.
  const reports = buildWorkflowReportsManifestSection(
    workflowSnapshotReports(snapshot),
    workflowSnapshotReportCount(snapshot),
  );
  if (reports !== undefined) meta.reports = reports;

  // The chips payload for user-facing artifacts. This is the **sole** data source of the
  // notification row's chips: cold-resume hydration reads it back verbatim through shared's zod,
  // and one missing key means the chips are gone for good. Always attached at all three terminal
  // states, for the same reason as reports.
  const artifactsSection = buildWorkflowArtifactsManifestSection(
    workflowSnapshotArtifacts(snapshot),
  );
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

/**
 * Tracker terminal status → the manifest's three terminal literals (`failed` → errored,
 * `cancelled` → stopped); non-terminal (running / lost etc.) returns undefined (no payload).
 * A snapshot carrying its own `runStatus` wins (see workflowSnapshotTerminal).
 */
function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * The wall-clock duration in the notification (the completion card's "time" cell, see
 * docs/dynamic-workflow/transcript-and-notifications.md "How long it took").
 *
 * Two sources, take the **larger**:
 *   - This incarnation: `completedAt - startedAt`, the stretch the settling process itself saw;
 *   - The whole lineage's active duration: `activeDurationMs`, summed by the port from the journal
 *     (every incarnation of a resume + each predecessor along `resumedFrom`); absent means unreadable.
 *
 * Defect cause (2026-09-21): reporting only this incarnation turned a "ran four hours, one
 * revision" run into 12 seconds — a revision and a resume each restart the in-process clock, and
 * that incarnation is mostly cache replay. Taking the max instead of just the lineage guards the
 * rule "never under-report what this process itself witnessed": when the old run's events predate
 * this bookkeeping or the journal read side is absent, `activeDurationMs` is missing and we fall
 * back to this incarnation; normally the lineage value is never smaller (it includes this one).
 *
 * If both sources are unreadable, the whole field is absent (the card shows `—`), never 0.
 */
function workflowNotificationDurationMs(snapshot: BackgroundTaskSnapshot): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  const ownLifeMs =
    startedAt === undefined || completedAt === undefined
      ? undefined
      : nonNegativeFinite(completedAt - startedAt);
  const lineageMs =
    "activeDurationMs" in snapshot ? nonNegativeFinite(snapshot.activeDurationMs) : undefined;
  if (ownLifeMs === undefined) return lineageMs;
  return lineageMs === undefined ? ownLifeMs : Math.max(ownLifeMs, lineageMs);
}

/** Only a non-negative finite number counts as a duration; anything else (NaN / Infinity / negative / non-number) reads as "unknowable". */
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The dwf progressive reports on a snapshot. `BackgroundTaskSnapshot` is a union (one branch each
 * for bash / subagent / legacy workflow / dwf), only the dwf branch has `reports`, so narrow by
 * `in` rather than asserting. The shape is still defensively checked: input on this path comes
 * from a port implementation, and the snapshot is a cross-package contract.
 */
/**
 * The dwf script file on a snapshot (absolute path). Narrowing matches {@link workflowSnapshotReports}
 * (`in` rather than an assertion: `BackgroundTaskSnapshot` is a four-way union and only the dwf
 * branch has this key), then the shape goes through typeof once more — the snapshot is a
 * cross-package contract, and an old port / stub may well omit it.
 */
export function workflowSnapshotScriptPath(
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined || !("scriptPath" in snapshot)) return undefined;
  return typeof snapshot.scriptPath === "string" && snapshot.scriptPath.length > 0
    ? snapshot.scriptPath
    : undefined;
}

export function workflowSnapshotReports(
  snapshot: BackgroundTaskSnapshot | undefined,
): readonly unknown[] | undefined {
  if (snapshot === undefined || !("reports" in snapshot)) return undefined;
  return Array.isArray(snapshot.reports) ? snapshot.reports : undefined;
}

/** The real report count on a snapshot (`reports` carries only the first 256); absent means an old snapshot and the read side falls back to the entry count. */
export function workflowSnapshotReportCount(
  snapshot: BackgroundTaskSnapshot | undefined,
): number | undefined {
  if (snapshot === undefined || !("reportCount" in snapshot)) return undefined;
  return typeof snapshot.reportCount === "number" ? snapshot.reportCount : undefined;
}

/**
 * The dwf **user-facing artifacts** on a snapshot (published via `artifact.*`, not the `output`
 * return value). Narrowing matches {@link workflowSnapshotReports} (`in` rather than an assertion:
 * `BackgroundTaskSnapshot` is a four-way union and only the dwf branch has this key), with the
 * shape going through defensive parsing once more — the snapshot is a cross-package contract.
 */
export function workflowSnapshotArtifacts(
  snapshot: BackgroundTaskSnapshot | undefined,
): ReturnType<typeof toPublishedArtifactSummaries> {
  if (snapshot === undefined || !("artifacts" in snapshot)) return undefined;
  return toPublishedArtifactSummaries(snapshot.artifacts);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return runtimeString(record?.[key]);
}
