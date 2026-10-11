import type {
  WorkflowLaunchMeta,
  WorkflowSettingsAmendMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readWorkflowName } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import type { WorkflowFillGraph } from "@/v4/workflowRunCardJoin.js";

/**
 * Resolves end-of-turn run cards: which **sources** in this turn named
 * a run. Pure function, following the same seam as `resolveCronAutomationTurnCards`.
 *
 * Three sources, one rule—every source that names a runId gets a card:
 * - Direct launch turn (`unit.workflowLaunch`): metadata includes runId / toolCallId /
 *   name; this is the turn's only presentation (the user row is hidden).
 * - CreateWorkflow row: join by toolCallId (`run.toolCallId` in the projection is the launching row); the row itself does not name runId,
 *   so a row with no joined run (rejected / failed to compile) gets no card.
 * - ResumeWorkflowRun row: display payload includes runId (the projection's toolCallId reuses the launching row across resume, so lookup by toolCallId
 *   will never find it).
 *
 * Charts belong to the run: look them up from the host chart map by the run's **launching** toolCallId, regardless of which row owns the card—so a resume row
 * uses the same chart as the launching row. A source still gets a card when it cannot join the live projection (evicted / cold recovery), with `summary` absent and the card falling back to a neutral
 * single row. Show only one card per run in a turn (the first source wins).
 *
 * One exception: a **settings turn with an in-place change** (`rowOnly`) names a run without launching or resuming it—it only changed
 * that run's concurrency limit. Its card already appeared in the turn that launched it, so this source renders only the line above.
 */
export interface WorkflowTurnDigest {
  key: string;
  /** Source id owning this card (mapped to the launching row id by `resolveWorkflowRunOpenToolCallId` when opening the side panel). */
  toolCallId: string;
  runId: string;
  /** Script `name`; the renderer supplies a localized fallback when absent. */
  name: string | undefined;
  graph: WorkflowCausalityGraphData | undefined;
  /** Name and type of filled holes (from fill-row input); present only for runs with fills. */
  holeLabels?: WorkflowFillGraph["holeLabels"];
  /** Joined summary from the live projection; absent means the run is not projected and the card falls back to a neutral one-line "ended" state. */
  summary: WorkflowRunCardSummary | undefined;
  /**
   * Settings turn: which run this card's run was amended from by "Configure," and what changed. When present, add a line above the card saying "Settings adjusted · …"; `at` is the turn's timestamp.
   */
  settings?: { amend: WorkflowSettingsAmendMeta; at?: number };
  /**
   * **Render only the line, not a card**: an in-place settings turn (only the concurrency limit changed; the run is still running and `amend` has no `predecessorRunId`). The named run was not replaced and its identity is unchanged;
   * its card already appeared in the launch turn, so rendering another one here would look like a second run. Always present with `settings`.
   */
  rowOnly?: true;
}

interface WorkflowTurnDigestSource {
  workflowLaunch?: WorkflowLaunchMeta;
  assistantWorkRows: readonly AssistantWorkRow[];
  /** Start time for this turn (timestamp shown on the settings line). */
  startedAt?: number;
}

interface WorkflowTurnDigestJoin {
  byToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  byRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  graphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
  /** runId → latest effective filled script graph (`buildWorkflowFillGraphByRunId`); after a fill, the card uses this instead of the launch-row graph. */
  fillGraphByRunId?: ReadonlyMap<string, WorkflowFillGraph>;
}

export function resolveWorkflowTurnDigests(
  unit: WorkflowTurnDigestSource,
  join: WorkflowTurnDigestJoin,
): WorkflowTurnDigest[] {
  const digests: WorkflowTurnDigest[] = [];
  const seen = new Set<string>();
  // The graph belongs to the run (docs/dynamic-workflow/presentation.md, “The model” under “Holes
  // on the timeline”): use the latest fill-row graph for a run with fills; otherwise use the launch toolCallId.
  const graphOf = (originToolCallId: string | undefined, runId: string) =>
    join.fillGraphByRunId?.get(runId)?.graph ??
    (originToolCallId === undefined ? undefined : join.graphByToolCallId?.get(originToolCallId));

  const launch = unit.workflowLaunch;
  if (launch !== undefined) {
    // In-place settings turn: `amend` has no predecessorRunId (absence means "no predecessor; the run amended itself,"
    // workflow-row-meta.ts). It is the only source that names a run without launching/resuming it, so it does **not** consume a card slot for this turn;
    // a source that actually launched the run in this turn still gets its card.
    const rowOnly = launch.amend !== undefined && launch.amend.predecessorRunId === undefined;
    if (!rowOnly) seen.add(launch.runId);
    digests.push({
      graph: graphOf(launch.toolCallId, launch.runId),
      ...(join.fillGraphByRunId?.get(launch.runId) === undefined
        ? {}
        : { holeLabels: join.fillGraphByRunId.get(launch.runId)!.holeLabels }),
      key: `launch:${launch.toolCallId}`,
      name: launch.name,
      runId: launch.runId,
      summary: join.byRunId?.get(launch.runId),
      toolCallId: launch.toolCallId,
      ...(rowOnly ? { rowOnly: true as const } : {}),
      ...(launch.amend === undefined
        ? {}
        : {
            settings: {
              amend: launch.amend,
              ...(unit.startedAt === undefined ? {} : { at: unit.startedAt }),
            },
          }),
    });
  }

  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall") continue;
    const created = join.byToolCallId?.get(row.toolCallId);
    if (created !== undefined) {
      if (seen.has(created.runId)) continue;
      seen.add(created.runId);
      digests.push({
        graph: graphOf(row.toolCallId, created.runId),
        ...(join.fillGraphByRunId?.get(created.runId) === undefined
          ? {}
          : { holeLabels: join.fillGraphByRunId.get(created.runId)!.holeLabels }),
        key: `${row.rowId}:${row.toolCallId}`,
        name: readWorkflowName(row.input),
        runId: created.runId,
        summary: created,
        toolCallId: row.toolCallId,
      });
      continue;
    }
    if (row.display?.kind !== "resume_workflow_run") continue;
    const runId = row.display.runId;
    if (seen.has(runId)) continue;
    seen.add(runId);
    const resumed = join.byRunId?.get(runId);
    digests.push({
      // The launching-row id is known only after joining the projection; a resume card without a projected run has no chart to look up.
      graph: graphOf(resumed?.toolCallId, runId),
      ...(join.fillGraphByRunId?.get(runId) === undefined
        ? {}
        : { holeLabels: join.fillGraphByRunId.get(runId)!.holeLabels }),
      key: `${row.rowId}:${row.toolCallId}`,
      name: undefined,
      runId,
      summary: resumed,
      toolCallId: row.toolCallId,
    });
  }
  return digests;
}
