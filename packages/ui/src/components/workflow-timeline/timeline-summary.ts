import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { workflowSubagentModelCardLabel } from "./subagent-model-label.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";
import type { IntlInstance } from "@/i18n/createIntl.js";

/**
 * Copy data for card-header details and the footer summary row. The sidebar status header also reads this summary row—one run must use the same wording in both places.
 *
 * Pure functions with injected intl: count copy uses formatPlural to choose the correct form for each language's plural rules.
 */
type TimelineIntl = Pick<IntlInstance, "formatMessage" | "formatPlural">;

export interface TimelineCounts {
  phases: number;
  /** Number of unique subagent lanes (excluding synthetic lanes). */
  agents: number;
  steps: number;
}

export function timelineCounts(
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): TimelineCounts {
  const lanes = new Set<string>();
  for (const station of model.stations) {
    for (const pill of station.pills) if (pill.laneClass === "agent") lanes.add(pill.lane.id);
  }
  // Drafts do not render pills; the scanner provides the subagent count directly.
  const agents = model.draft?.agents ?? lanes.size;
  return { agents, phases: model.stations.length, steps: graph?.steps.length ?? 0 };
}

/** Maximum iteration reached by a station on a loop; 0 when there is no loop or it has not been reached. */
export function timelineRounds(model: WorkflowTimelineModel): number {
  let rounds = 0;
  for (const station of model.stations) {
    if (station.onLoop && station.rounds > rounds) rounds = station.rounds;
  }
  return rounds;
}

function countLabel(intl: TimelineIntl, id: string, value: number): string {
  return intl.formatPlural({ id }, value, { count: value.toLocaleString() });
}

/**
 * The right side of the confirmation-dialog header shows only the phase count; subagent and step counts are visible in the timeline below,
 * so repeating them in the header would add noise.
 */
export function workflowPhasesDetail(
  intl: TimelineIntl,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
): string {
  const counts = timelineCounts(model, graph);
  // Open holes do not count as stages (docs/dynamic-workflow/presentation.md, “Holes on the timeline”): “2 stages · 2 holes.”
  const holes = model.stations.filter(
    (station) => station.hole !== undefined && station.hole.state !== "filled",
  ).length;
  const phases = countLabel(intl, "chat.toolCall.workflow.card.phases", counts.phases - holes);
  return holes === 0
    ? phases
    : `${phases} · ${countLabel(intl, "chat.toolCall.workflow.card.holes", holes)}`;
}

/** Subagent segment: count active subagents while running; show the total after completion (take the larger projected/static count). */
function agentsPart(
  intl: TimelineIntl,
  model: WorkflowTimelineModel,
  run: WorkflowRunState | undefined,
): string {
  if (run !== undefined && (run.status === "pending" || run.status === "running")) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    return countLabel(intl, "chat.toolCall.workflow.card.agentsWorking", working);
  }
  const agents = Math.max(run?.actors.length ?? 0, timelineCounts(model, undefined).agents);
  return countLabel(intl, "chat.toolCall.workflow.card.agents", agents);
}

/**
 * Details on the right side of the card header: **show only phase and subagent counts** (no "steps" on the card header).
 * Drafting / awaiting-confirmation states use static graph counts. After attaching to a run, the phase count stays fixed and the subagent count
 * becomes "n working" while running or the total after completion. Steps, tokens, rounds, and artifacts stay in the run details summary row (`workflowSummaryParts`).
 */
export function workflowHeaderDetail(
  intl: TimelineIntl,
  model: WorkflowTimelineModel,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /**
   * Resolved subagent model name (see subagent-model-label.ts): since the detail string already reports the number of subagents, put the model name
   * after it as the final segment in the same muted text—no chip or prefix. Keep the effort and canonical model ID in the tooltip.
   * Omit this segment when the run did not specify a model.
   */
  subagentModelName?: string,
): string {
  const parts = [workflowPhasesDetail(intl, model, graph), agentsPart(intl, model, run)];
  if (subagentModelName !== undefined) {
    parts.push(subagentModelName);
  }
  return parts.join(" · ");
}

/**
 * Compute the header-detail string and tooltip together: both card types (v4 timeline tail summary and legacy host run card) must say the same thing,
 * so there is one implementation for whether to include the model name and what to put in the tooltip. Omit the whole detail when a timeline model cannot be built.
 */
export function workflowCardDetail(
  intl: TimelineIntl,
  model: WorkflowTimelineModel | undefined,
  graph: WorkflowCausalityGraphData | undefined,
  run: WorkflowRunState | undefined,
  /** providerId to provider name; if missing, use the bare modelId (never display the provider ID). */
  providerName?: (providerId: string) => string | undefined,
): { detail: string; title?: string } | undefined {
  if (model === undefined) {
    return undefined;
  }
  const subagentModel = workflowSubagentModelCardLabel(run?.subagentModel, {
    formatMessage: intl.formatMessage,
    ...(providerName === undefined ? {} : { providerName }),
  });
  return {
    detail: workflowHeaderDetail(intl, model, graph, run, subagentModel?.name),
    ...(subagentModel === undefined ? {} : { title: subagentModel.title }),
  };
}

/**
 * Segments for the run details summary row: `1 agent working · 4/7 steps · 42,118 tokens · round 2`; terminal runs use
 * `3 agents · 11/11 steps · … · 3 rounds · 2 artifacts`. Returns strings only; the renderer supplies separators.
 * The last segment counts **artifacts** (outputs delivered to the user through `artifact.*`), not `report` entries: the Results section was removed,
 * so "results" no longer has a place in the UI.
 * Chat cards (tool-card footer and timeline tail summary) no longer use this; they show only phases and subagents (`workflowHeaderDetail`).
 * This row is now used only on the details page.
 */
export function workflowSummaryParts(
  intl: TimelineIntl,
  model: WorkflowTimelineModel,
  run: WorkflowRunState,
  options: {
    tokens?: boolean;
    /**
     * Resolved subagent model name (see subagent-model-label.ts): when present, this is the **first segment** of the summary row—
     * the row lists facts about the run, and the model is its first word. The status header therefore no longer shows a model chip.
     */
    subagentModelName?: string;
  } = {},
): string[] {
  const parts: string[] = [];
  if (options.subagentModelName !== undefined) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.run.subagentModel.label" },
        { model: options.subagentModelName },
      ),
    );
  }
  const active = run.status === "pending" || run.status === "running";
  if (active) {
    const working = run.actors.filter((actor) => actor.status === "running").length;
    parts.push(countLabel(intl, "chat.toolCall.workflow.card.agentsWorking", working));
  } else {
    const agents = Math.max(run.actors.length, timelineCounts(model, undefined).agents);
    parts.push(countLabel(intl, "chat.toolCall.workflow.card.agents", agents));
  }
  // Use the single @zcode/shared step-count implementation: visible + omitted (instances beyond the cap still count as steps).
  const { settled, total } = workflowRunStepCounts(run);
  parts.push(
    intl.formatMessage({ id: "chat.toolCall.workflow.card.steps" }, { done: settled, total }),
  );
  if (options.tokens !== false) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.card.tokens" },
        { count: run.usage.spentTokens.toLocaleString() },
      ),
    );
  }
  const rounds = timelineRounds(model);
  if (rounds >= 2) {
    parts.push(
      active
        ? intl.formatMessage({ id: "chat.toolCall.workflow.card.round" }, { count: rounds })
        : intl.formatMessage({ id: "chat.toolCall.workflow.card.rounds" }, { count: rounds }),
    );
  }
  const artifacts = run.artifacts?.length ?? 0;
  if (artifacts > 0) {
    parts.push(countLabel(intl, "chat.toolCall.workflow.card.artifacts", artifacts));
  }
  return parts;
}
