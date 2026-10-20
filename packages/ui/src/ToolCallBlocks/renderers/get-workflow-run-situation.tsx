/**
 * **Situation snapshot** for the GetWorkflowRun tool card: phase rail + health row (the roster is in
 * get-workflow-run-roster.tsx).
 *
 * The two rules exactly match the model-facing version
 * (apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts):
 *   1. **Omit missing values.** No timestamp means no age; no reading means no row. `0` is a fact,
 *      while "unknown" is another—never substitute 0 for the latter.
 *   2. Calculate all ages from the **snapshot time** `generatedAt`, not `Date.now()`: reopening a three-day-old card
 *      must not make its readings drift with today's time. If `generatedAt` is absent, show no ages.
 *
 * Layout: all rows wrap (flex-wrap); there is no fixed-width table, so narrow phone screens wrap instead of overflowing horizontally.
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowDuration } from "@/lib/workflowObservationFormat.js";

type WorkflowRunPhaseView = NonNullable<ToolCallGetWorkflowRunDisplay["phases"]>[number];
type WorkflowRunHealthView = NonNullable<ToolCallGetWorkflowRunDisplay["health"]>;

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/** Container for the situation section, using the same low-level container as the log panel in this card—not a second card style. */
export const SITUATION_BLOCK_CLASS =
  "min-w-0 space-y-1 rounded-lg border border-border bg-surface px-2 py-1.5";

/** A row in the situation section: wraps on narrow screens and aligns baselines so mixed numbers/text do not push each other out of alignment. */
export const SITUATION_ROW_CLASS = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5";

/**
 * Semantic colors for phase-status words. Uses the same decision rules as overall run status (run-status-presentation.ts):
 * active uses warning, completed uses success, not-yet-started is weakest, and unsettled terminal state is neutral.
 */
const PHASE_STATE_TEXT: Record<WorkflowRunPhaseView["state"], string> = {
  done: "text-success",
  current: "text-warning",
  ahead: "text-foreground-subtlest",
  unfinished: "text-foreground-subtle",
};

/**
 * Phase rail: one row per phase in declaration order. An `ahead` row shows only its number, name, and status—it has not happened yet,
 * so there are no rounds or steps to report.
 */
export function WorkflowRunPhaseTrack({
  phases,
  generatedAt,
  terminal,
}: {
  phases: readonly WorkflowRunPhaseView[];
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (phases.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-phases">
      {phases.map((phase, index) => {
        const cells: string[] = [];
        // rounds can be 0 only for `ahead`; a phase that has not started cannot say how many times it was entered.
        if (phase.rounds > 0) {
          cells.push(intl.formatPlural({ id: `${I18N_PREFIX}phase.rounds` }, phase.rounds));
        }
        if (phase.nodesSettled > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.settled` },
              { count: phase.nodesSettled },
            ),
          );
        }
        if (phase.nodesRunning > 0) {
          // "Still running" in a terminal run means unsettled, not active.
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${terminal ? "unfinished" : "running"}` },
              { count: phase.nodesRunning },
            ),
          );
        }
        const duration = phaseDuration(phase, generatedAt, terminal, intl.formatMessage);
        return (
          <div className={SITUATION_ROW_CLASS} key={`${phase.name}-${index}`}>
            <span className="shrink-0 tabular-nums text-foreground-subtlest">{index + 1}.</span>
            <span className="min-w-0 break-words text-foreground">{phase.name}</span>
            <span className={`shrink-0 ${PHASE_STATE_TEXT[phase.state]}`}>
              {intl.formatMessage({ id: `${I18N_PREFIX}phase.state.${phase.state}` })}
            </span>
            {cells.map((cell) => (
              <span className="text-foreground-subtle" key={cell}>
                {cell}
              </span>
            ))}
            {duration === undefined ? null : (
              <span className="text-foreground-subtlest">{duration}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function phaseDuration(
  phase: WorkflowRunPhaseView,
  generatedAt: number | undefined,
  terminal: boolean,
  formatMessage: FormatMessage,
): string | undefined {
  if (phase.enteredAt === undefined) return undefined;
  if (phase.exitedAt !== undefined) return formatWorkflowDuration(phase.exitedAt - phase.enteredAt);
  // No exit time: a live run says "so far"; a terminal run says nothing. Its exit time was never recorded,
  // and subtracting from the snapshot time would count hours after the process died as part of this phase.
  if (terminal) return undefined;
  const soFar = formatWorkflowAge(generatedAt, phase.enteredAt);
  return soFar === undefined
    ? undefined
    : formatMessage({ id: `${I18N_PREFIX}phase.soFar` }, { duration: soFar });
}

/**
 * Health row: whether the overall run is active, presented as one line of readings.
 *
 * `stalled` matters only for a live run (a terminal run is obviously inactive); for a terminal run, show a **leftover explanation**
 * instead—the roster's rows marked running are leftovers from when the process died. This is the only place on this card that states the unknown
 * (the other is the hint for hidden pending questions); silence would be read as "they are still running."
 *
 * Show `consecutiveFailures` / `cachedSteps` only when greater than 0: a zero reading is not news,
 * and the card is more economical with rows than the model-facing output.
 */
export function WorkflowRunHealthLine({
  health,
  generatedAt,
  terminal,
}: {
  health: WorkflowRunHealthView;
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  const cells: string[] = [];

  const lastProgress = formatWorkflowAge(generatedAt, health.lastProgressAt);
  if (lastProgress !== undefined) {
    cells.push(
      intl.formatMessage({ id: `${I18N_PREFIX}health.lastProgress` }, { age: lastProgress }),
    );
  }

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}health.concurrency` }, { effective, cap }));
    // Put reason and start time in separate cells instead of parentheses: parentheses differ between Chinese and English, and this row is meant to be scanned cell by cell.
    // reason is an open string; map known values to short labels and show unknown ones as-is.
    if (reason !== undefined) cells.push(throttleReasonLabel(reason, intl.formatMessage));
    const sinceAge = formatWorkflowAge(generatedAt, since);
    if (sinceAge !== undefined) {
      cells.push(
        intl.formatMessage({ id: `${I18N_PREFIX}health.concurrencySince` }, { age: sinceAge }),
      );
    }
  }

  if (!terminal) {
    const stalledAge = formatWorkflowAge(generatedAt, health.stalledSince);
    cells.push(
      health.stalledSince === undefined
        ? intl.formatMessage({ id: `${I18N_PREFIX}health.notStalled` })
        : stalledAge === undefined
          ? intl.formatMessage({ id: `${I18N_PREFIX}health.stalledNoClock` })
          : intl.formatMessage({ id: `${I18N_PREFIX}health.stalled` }, { age: stalledAge }),
    );
  }

  if (health.consecutiveFailures > 0) {
    cells.push(
      intl.formatPlural({ id: `${I18N_PREFIX}health.failures` }, health.consecutiveFailures),
    );
  }
  if (health.cachedSteps > 0) {
    cells.push(intl.formatPlural({ id: `${I18N_PREFIX}health.cachedSteps` }, health.cachedSteps));
  }

  const leftover = terminal ? health.leftoverRunning : undefined;
  if (cells.length === 0 && leftover === undefined) return null;
  return (
    <div className="min-w-0 space-y-1" data-testid="workflow-run-health">
      {cells.length === 0 ? null : (
        <div className={`${SITUATION_ROW_CLASS} text-ui-sm text-foreground-subtlest`}>
          {cells.map((cell) => (
            <span key={cell}>{cell}</span>
          ))}
        </div>
      )}
      {leftover === undefined ? null : (
        <p className="break-words text-ui-sm text-warning" data-testid="workflow-run-leftover">
          {intl.formatPlural({ id: `${I18N_PREFIX}health.leftover` }, leftover)}
        </p>
      )}
    </div>
  );
}
