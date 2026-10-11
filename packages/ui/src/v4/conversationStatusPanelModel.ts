import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  RunningSubagentSummary,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionWorkflowPhaseSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveSessionWorkflowPhases,
  workflowRunStepCounts,
} from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";
import { workflowRunParallelPhaseLabel } from "@/lib/workflowRunLine.js";

export interface ConversationStatusPanelGitModel {
  branchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  dirtyFileCount: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
  isClean: boolean;
}

export interface ConversationStatusPanelPlanModel {
  items: PlanState["items"];
  displayItems: PlanState["items"];
  completedCount: number;
  waitingCount: number;
  totalCount: number;
}

export interface ConversationStatusPanelSessionPlanItem {
  rowId: number;
  toolCallId: string;
  markdown: string;
  title?: string;
  planFilePath?: string;
}

export interface ConversationStatusPanelSessionPlansModel {
  items: ConversationStatusPanelSessionPlanItem[];
}

export interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  controlWorkId?: string;
  cancellable?: boolean;
}

/** One row in the Workflows section. Fields form three clusters because each represents an independently optional fact: `status` / `nodesSettled` / `nodesTotal` come from the `workflowRuns` projection; `title` / `startedAt` are static background-task metadata; `workId` / `cancellable` are required for Stop and appear only while background work is running. Express absence by omitting the field, not as 0 or an empty string: the renderer uses this to decide whether to show status/step counts, duration, or Stop, and a fake 0/0 would say “no steps ran.” See `buildRunningWorkflowRuns` for why the fields are grouped. */
export interface ConversationStatusPanelWorkflowRun {
  /** Identity and React key; a degraded row uses workId instead (they are equivalent). */
  runId: string;
  /** The row is not clickable when absent (there is no detail tab to open), equivalent to a run without toolCallId in the projection. */
  toolCallId?: string;
  /** Status text requires a supporting run; degraded rows have none. */
  status?: "pending" | "running";
  nodesSettled?: number;
  nodesTotal?: number;
  /**
   * Station list (declaration order) and current station, derived the same way as the sidebar run
   * row through shared `deriveSessionWorkflowPhases`. Present only when backed by a run, like
   * `status`; degraded rows omit it. An empty array means the script declares no phases.
   */
  phases?: SessionWorkflowPhaseSummary[];
  currentPhase?: string;
  /** Display name. When `title ≡ workId`, it means “unnamed,” and the renderer substitutes an i18n fallback. The core workflowTaskSubject fallback ultimately uses taskId (≡ runId ≡ workId), while the projection copies a non-empty description directly to title; therefore title exactly equal to ID is the only reliable unnamed signal. The model does not perform this replacement because i18n does not belong in the model layer; it passes title through unchanged. */
  title?: string;
  startedAt?: number;
  /** Control handle required by Stop; present only while work is running (finished work has nothing left to cancel). */
  workId?: string;
  cancellable?: boolean;
}

/** Intent describing which run’s detail page to open. The host supplies session/workspace identity, so the panel does not know the scope (same handler as tool cards; there is no second open path). Keep it in the model file rather than the component: composer-badge direct-open checks and panel rows use the same shape, so the component imports the type from the model instead of the reverse. */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/** Convert a panel row to an open intent. Return null without toolCallId (no detail tab to open). Include a name only when real: title ≡ runId is the unnamed-run fallback; freezing runId into the tab label is worse than a generic fallback. Panel rows and composer-badge direct navigation share this conversion. */
export function workflowRunOpenTarget(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (!run.toolCallId) return null;
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    ...(run.title && run.title !== run.runId ? { workflowName: run.title } : {}),
  };
}

export interface ConversationStatusPanelModel {
  hasContent: boolean;
  git: ConversationStatusPanelGitModel | null;
  goal: GoalState | null;
  sessionPlans: ConversationStatusPanelSessionPlansModel | null;
  plan: ConversationStatusPanelPlanModel | null;
  runningBashWorks: BackgroundWorkSummary[];
  runningSubagentWorks: ConversationStatusPanelRunningSubagent[];
  runningWorkflowRuns: ConversationStatusPanelWorkflowRun[];
}

export interface BuildConversationStatusPanelModelInput {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  workspacePath?: string;
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly RunningSubagentSummary[];
  workflowRuns?: readonly WorkflowRunState[];
}

function buildGitModel({
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeChangeSummary,
}: Pick<
  BuildConversationStatusPanelModelInput,
  "gitSummary" | "gitDirtyFileCount" | "gitWorktreeChangeSummary"
>): ConversationStatusPanelGitModel | null {
  if (!gitSummary?.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // Before v4, any Git repository created a Git model, so even a clean repo showed a status card at the top right.
  // Old ChatView showed Git Tools only when the worktree had row-level changes.
  if (added + removed <= 0) {
    return null;
  }
  const isClean =
    !gitSummary.isDirty &&
    gitDirtyFileCount === 0 &&
    added === 0 &&
    removed === 0 &&
    gitSummary.ahead === 0;

  return {
    branchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    dirtyFileCount: gitDirtyFileCount,
    added,
    removed,
    ahead: gitSummary.ahead,
    behind: gitSummary.behind,
    isClean,
  };
}

function buildPlanModel(plan: PlanState | null | undefined) {
  if (!plan || plan.items.length === 0) {
    return null;
  }
  const completed = plan.items.filter((item) => item.status === "completed");
  return {
    items: plan.items,
    // Re-grouping by status would make a Todo jump to the end when completed and break the authoritative TodoWrite snapshot order.
    // Preserve the original array; let the renderer handle scrolling and status styles.
    displayItems: plan.items,
    completedCount: completed.length,
    waitingCount: plan.items.length - completed.length,
    totalCount: plan.items.length,
  };
}

function buildSessionPlansModel(
  rows: readonly ToolCallRow[] | undefined,
  workspacePath: string | undefined,
): ConversationStatusPanelSessionPlansModel | null {
  if (!rows?.length) return null;
  const items = rows
    .filter(
      (row) =>
        row.toolName === "ExitPlanMode" &&
        (row.status === "success" || row.status === "error" || row.status === "cancelled"),
    )
    .toSorted((left, right) => right.rowId - left.rowId)
    .flatMap((row) => {
      const content = extractPlanToolCallContent(row, workspacePath ?? "");
      if (!content.markdown) return [];
      const title = getPlanDirectoryTitle(content.markdown);
      return [
        {
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          markdown: content.markdown,
          ...(title ? { title } : {}),
          ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
        },
      ];
    });
  return items.length > 0 ? { items } : null;
}

/** Workflows section: join active runs with workflow background tasks by workId ≡ runId. This is an existing schema fact (the kind comment in backgroundWorkSummarySchema and the “workflow” comment in backgroundResultOriginMetaSchema), so join directly by primary key without the Agent-row duplicate-identity disambiguation. Either side can be absent; handle absence by field meaning, not a single work-status check. title/startedAt are static metadata and come from work in any status; dropping them at resultPending would make a still-running run flash to an i18n fallback and lose duration. workId/cancellable are needed for Stop and are included only while work is running; finished work cannot be cancelled. A run without work still gets a row from projection status/step facts, but has no title/duration/Stop. Work without a run means an older CLI omits the workflowRuns projection key. Degrade it to title/duration/Stop only, appended after run-backed rows because it has no start-order position; inserting it in the middle would invent an order. This fallback exists so cancellation remains available under projection skew, so include only running work; finished work without a run has no action and would be a dead row. */
function buildRunningWorkflowRuns(
  runs: readonly WorkflowRunState[] | undefined,
  workflowWorkByWorkId: ReadonlyMap<string, BackgroundWorkSummary>,
): ConversationStatusPanelWorkflowRun[] {
  const rows: ConversationStatusPanelWorkflowRun[] = [];
  const joinedWorkIds = new Set<string>();
  for (const run of runs ?? []) {
    // pending is also active: the run has started but has not dispatched its first node, so hiding it leaves a gap between
    // “workflow started” and the panel showing it.
    if (run.status !== "pending" && run.status !== "running") continue;
    const work = workflowWorkByWorkId.get(run.runId);
    if (work) joinedWorkIds.add(run.runId);
    // Counts share the compact chat card’s source (the single workflowRunStepCounts implementation in @zcode/shared: in-table + out-of-table).
    const steps = workflowRunStepCounts(run);
    rows.push({
      runId: run.runId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      phases: deriveSessionWorkflowPhases(run),
      ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
      ...(work?.status === "running"
        ? {
            workId: work.workId,
            // Default to cancellable, like Agent rows (`!== false`); a missing Stop button is worse than an unnecessary one.
            cancellable: work.cancellable !== false,
          }
        : {}),
    });
  }
  // Order is projection run order = start order; do not sort in the model or rows will move on every projection update.
  for (const [workId, work] of workflowWorkByWorkId) {
    if (joinedWorkIds.has(workId) || work.status !== "running") continue;
    rows.push({
      runId: workId,
      workId,
      title: work.title,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
    });
  }
  return rows;
}

/**
 * Words describing what a run is doing now (docs/dynamic-workflow/presentation.md, “Other places
 * a run appears”); the run row's second line and the capsule share this rule:
 * - pending → status word;
 * - no declared phases → step count (the only place the step count appears);
 * - more than one station is active → join their names with ` ∥ ` (parallel stations are equally current);
 * - otherwise, use the current station; if none exists yet (the run started but has not entered its first phase), use the status word;
 * - degraded row (no status) → null: when status is unknown, say nothing.
 * The model returns structure only; the rendering layer composes copy (status words and step-count keys) through i18n.
 */
export type ConversationStatusPanelWorkflowRunWords =
  | { kind: "status"; status: "pending" | "running" }
  | { kind: "steps"; done: number; total: number }
  | { kind: "phases"; text: string };

export function workflowRunWords(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunWords | null {
  if (run.status === undefined) return null;
  if (run.status === "pending") return { kind: "status", status: "pending" };
  const phases = run.phases ?? [];
  if (phases.length === 0) {
    return { kind: "steps", done: run.nodesSettled ?? 0, total: run.nodesTotal ?? 0 };
  }
  const parallel = workflowRunParallelPhaseLabel(phases);
  if (parallel !== undefined) return { kind: "phases", text: parallel };
  if (run.currentPhase !== undefined) return { kind: "phases", text: run.currentPhase };
  return { kind: "status", status: "running" };
}

/** Direct navigation from the composer badge: return an open intent only when the current conversation has exactly one active workflow run with a detail page. Otherwise return null so the badge can expand to a pill. No terminals/subagents: the badge is their only entry point and direct navigation would hide them. Exactly one workflow: choosing among multiple is the user’s decision. Require toolCallId: degraded rows (work exists but run is absent) and old-CLI runs have no detail page, just like non-clickable panel rows; use the pill so Stop remains available. The input is buildConversationStatusPanelModel’s output, so the badge and pill share the same runtime facts. */
export function resolveSoleRunningWorkflowRunTarget(
  model: Pick<
    ConversationStatusPanelModel,
    "runningBashWorks" | "runningSubagentWorks" | "runningWorkflowRuns"
  >,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (model.runningBashWorks.length > 0 || model.runningSubagentWorks.length > 0) return null;
  if (model.runningWorkflowRuns.length !== 1) return null;
  return workflowRunOpenTarget(model.runningWorkflowRuns[0]!);
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const git = input.isOfficeMode ? null : buildGitModel(input);
  const goal = input.goal ?? null;
  const sessionPlans = buildSessionPlansModel(input.sessionPlans, input.workspacePath);
  const plan = buildPlanModel(input.plan);
  const runningBashWorks: BackgroundWorkSummary[] = [];
  const workflowWorkByWorkId = new Map<string, BackgroundWorkSummary>();
  const subagentControlByChildSessionId = new Map<string, BackgroundWorkSummary | null>();
  for (const work of input.backgroundWorks ?? []) {
    if (work.kind === "workflow") {
      // “workflow” (a workflow run) used to be grouped with bash under Terminals; that was a known misclassification to preserve the Stop entry.
      // It now has its own Workflows section, so only workId ≡ runId enters the workflow join table.
      // Leaving it in runningBashWorks would show the same run in both sections.
      //
      // Check this branch before the running gate: title and start time remain valid for finished work (see
      // buildRunningWorkflowRuns for the field grouping); status is checked there by field. workId is
      // the primary key, so duplicates indicate upstream corruption and must not be disambiguated.
      workflowWorkByWorkId.set(work.workId, work);
      continue;
    }
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      runningBashWorks.push(work);
    } else if (work.kind === "subagent" && work.childSessionId) {
      // When the directory projection took over Agent display, workId/cancellable from old backgroundWorks was no longer joined back,
      // making the Stop entry disappear. Accept only an exact unique childSessionId match; if identity is duplicated or absent, omit control
      // rather than guessing by title/time and stopping the wrong task.
      const existing = subagentControlByChildSessionId.get(work.childSessionId);
      subagentControlByChildSessionId.set(
        work.childSessionId,
        existing === undefined ? work : null,
      );
    }
  }
  const runningSubagentWorks: ConversationStatusPanelRunningSubagent[] = (
    input.runningSubagents ?? []
  ).map((subagent) => {
    const controlWork = subagentControlByChildSessionId.get(subagent.childSessionId);
    if (!controlWork) return subagent;
    return {
      ...subagent,
      controlWorkId: controlWork.workId,
      cancellable: controlWork.cancellable !== false,
    };
  });
  const projectedChildSessionIds = new Set(
    runningSubagentWorks.map((subagent) => subagent.childSessionId),
  );
  for (const [childSessionId, controlWork] of subagentControlByChildSessionId) {
    if (!controlWork || projectedChildSessionIds.has(childSessionId)) continue;
    // backgroundWorks already has authoritative running state with an exact childSessionId, but
    // there may briefly be no row while the subagents cold/live projections switch. The old model hid all Agent controls
    // during that gap. Use only a unique authoritative work item to restore the same control; still refuse to guess on duplicate identity.
    runningSubagentWorks.push({
      agentId: controlWork.workId,
      childSessionId,
      controlWorkId: controlWork.workId,
      subagentType: "subagent",
      title: controlWork.title,
      status: controlWork.blocked ? "blocked" : "running",
      startedAt: controlWork.startedAt,
      cancellable: controlWork.cancellable !== false,
    });
  }

  const runningWorkflowRuns = buildRunningWorkflowRuns(input.workflowRuns, workflowWorkByWorkId);

  return {
    git,
    goal,
    sessionPlans,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    runningWorkflowRuns,
    hasContent: Boolean(
      git ||
      goal ||
      sessionPlans ||
      plan ||
      runningBashWorks.length > 0 ||
      runningSubagentWorks.length > 0 ||
      runningWorkflowRuns.length > 0,
    ),
  };
}
