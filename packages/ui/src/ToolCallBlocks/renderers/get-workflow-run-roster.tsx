/**
 * **Subagent roster** for the GetWorkflowRun tool card (the other half of the situation snapshot; phase tracks and health rows are in
 * get-workflow-run-situation.tsx).
 *
 * Each row uses the same wording as the model-facing view
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts):
 * “who · where · which phase · which stage · what they are doing · how many tokens,” with “what they are doing”
 * varying by phase — running agents show progress and the last tool, waiting agents show what they await and for how long, and parked agents show which
 * question they await. This is the card's purpose: spot who is stuck at a glance.
 *
 * The payload is **flat rows** (no nested `currentAsk`), so whether there is an active ask is inferred from the presence of those readings;
 * omit missing values and never use 0 to represent unknown.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/createIntl.js";
import {
  formatWorkflowAge,
  formatWorkflowDuration,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import {
  SITUATION_BLOCK_CLASS,
  SITUATION_ROW_CLASS,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";

type WorkflowRunSubagentView = NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number];
type RosterIntl = Pick<IntlInstance, "formatMessage" | "formatPlural">;

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/**
 * Semantic colors for phase labels. The label is always present; color is only a secondary channel (DESIGN: status cannot rely on color alone):
 * active work uses warning, waiting and unresolved terminal states use neutral, completed uses success, and failed uses destructive.
 * `parked` also uses the active color — it is waiting for a person to answer and needs attention; it is not idle.
 */
const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {
  idle: "text-foreground-subtlest",
  executing: "text-warning",
  waiting: "text-foreground-subtle",
  parked: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  unfinished: "text-foreground-subtle",
};

export function WorkflowRunSubagentRoster({
  subagents,
  generatedAt,
}: {
  subagents: readonly WorkflowRunSubagentView[];
  generatedAt: number | undefined;
}) {
  const { intl } = useZCodeIntl();
  // Render nothing for an empty roster: not having created subagents does not need a whole section to explain it.
  if (subagents.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-subagents">
      {subagents.map((subagent) => {
        const activity = subagentActivity(subagent, generatedAt, intl);
        return (
          <div className="min-w-0 space-y-0.5" key={`${subagent.siteId}@${subagent.ordinal}`}>
            <div className={`${SITUATION_ROW_CLASS} text-ui-sm`}>
              {/* Do not synthesize a fallback name for an anonymous subagent; leave it blank so its address still identifies it. */}
              {subagent.name === undefined ? null : (
                <span className="min-w-0 break-words text-foreground">{subagent.name}</span>
              )}
              <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {subagent.siteId}@{subagent.ordinal}
              </span>
              <span className={`shrink-0 ${SUBAGENT_STATE_TEXT[subagent.state]}`}>
                {intl.formatMessage({ id: `${I18N_PREFIX}subagent.state.${subagent.state}` })}
              </span>
              {subagent.phaseName === undefined ? null : (
                <span className="min-w-0 break-words text-foreground-subtle">
                  {intl.formatMessage(
                    { id: `${I18N_PREFIX}subagent.phase` },
                    { name: subagent.phaseName },
                  )}
                </span>
              )}
              {activity.map((cell) => (
                <span className="min-w-0 break-words text-foreground-subtle" key={cell}>
                  {cell}
                </span>
              ))}
              {subagent.tokens > 0 ? (
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.usage.tokens" },
                    { tokens: formatWorkflowTokenCount(subagent.tokens) },
                  )}
                </span>
              ) : null}
            </div>
            {subagent.instructionsHead === undefined ||
            subagent.instructionsHead.length === 0 ? null : (
              // The task line belongs to the preceding row rather than representing a new fact; indent it instead of starting another cell.
              <p className="min-w-0 break-words pl-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: `${I18N_PREFIX}subagent.task` },
                  { task: subagent.instructionsHead },
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** If any of those progress readings is present, the row represents an ask (the flat payload has no `currentAsk` marker). */
function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {
  return (
    subagent.startedAt !== undefined ||
    subagent.turn !== undefined ||
    subagent.toolCalls !== undefined ||
    subagent.lastTool !== undefined ||
    subagent.instructionsHead !== undefined
  );
}

function subagentActivity(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  intl: RosterIntl,
): string[] {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    // Only qid is available, not the question timestamp: the card payload has no pendingQuestions, so this row cannot say how long it has waited.
    return [
      intl.formatMessage({ id: `${I18N_PREFIX}subagent.parkedOn` }, { qid: subagent.parkedOn }),
    ];
  }
  if (subagent.state === "waiting") return waitCells(subagent, generatedAt, intl);
  if (subagent.state === "unfinished" && hasCurrentAsk(subagent)) {
    return [intl.formatMessage({ id: `${I18N_PREFIX}subagent.inFlightAtStop` })];
  }
  if (hasCurrentAsk(subagent)) {
    const cells = executingCells(subagent, generatedAt, intl);
    // An ask is active but has no readings (legacy journal): fall back to settled step count instead of leaving a row with only a phase label.
    return cells.length > 0 ? cells : settledCells(subagent, intl);
  }
  return settledCells(subagent, intl);
}

function executingCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  intl: RosterIntl,
): string[] {
  const cells: string[] = [];
  const onStep = formatWorkflowAge(generatedAt, subagent.startedAt);
  if (onStep !== undefined) {
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}subagent.onStep` }, { age: onStep }));
  }
  if (subagent.turn !== undefined) {
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}subagent.turn` }, { count: subagent.turn }));
  }
  if (subagent.toolCalls !== undefined) {
    cells.push(intl.formatPlural({ id: `${I18N_PREFIX}subagent.toolCalls` }, subagent.toolCalls));
  }
  if (subagent.lastTool !== undefined) {
    const { name, target, at } = subagent.lastTool;
    const age = formatWorkflowAge(generatedAt, at);
    cells.push(
      [
        intl.formatMessage({ id: `${I18N_PREFIX}subagent.lastTool` }, { name }),
        target,
        age === undefined ? undefined : intl.formatMessage({ id: `${I18N_PREFIX}age` }, { age }),
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" "),
    );
  }
  return cells;
}

function waitCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  intl: RosterIntl,
): string[] {
  if (subagent.waitCause === undefined) return [];
  const cells = [
    intl.formatMessage({
      id: `${I18N_PREFIX}subagent.${subagent.waitCause === "slot" ? "waitingSlot" : "waitingBackoff"}`,
    }),
  ];
  // Put “waiting for” next to the reason and “waited for” at the end; adjacent durations are hard to distinguish.
  const waited = formatWorkflowAge(generatedAt, subagent.waitSince);
  if (waited !== undefined) {
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}subagent.waitedFor` }, { age: waited }));
  }
  if (subagent.retryAfterMs !== undefined) {
    cells.push(
      intl.formatMessage(
        { id: `${I18N_PREFIX}subagent.retryIn` },
        { duration: formatWorkflowDuration(subagent.retryAfterMs) },
      ),
    );
  }
  return cells;
}

function settledCells(subagent: WorkflowRunSubagentView, intl: RosterIntl): string[] {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return [];
  const cells = [intl.formatPlural({ id: `${I18N_PREFIX}subagent.steps` }, subagent.stepsSettled)];
  if (subagent.stepsFailed > 0) {
    cells.push(
      intl.formatMessage(
        { id: `${I18N_PREFIX}subagent.stepsFailed` },
        { count: subagent.stepsFailed },
      ),
    );
  }
  return cells;
}
