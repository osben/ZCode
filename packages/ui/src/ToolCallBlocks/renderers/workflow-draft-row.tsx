import { useMemo, type ReactNode } from "react";
import type { ToolCallCreateWorkflowDisplay } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { cn } from "@/components/lib/utils.js";
import { DRAFT_FEEDBACK_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  formatWorkflowFeedbackTooltip,
  workflowDiagnosticLines,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowDiagnosticsSection,
  workflowFeedbackLedeMessageId,
} from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";

/**
 * Text shown in each ToolLayout slot for the compile feedback row.
 * Split from `create-workflow.tsx` to meet the oxlint 400-line max-lines rule, following the `createWorkflowInput.ts` precedent.
 *
 * Use only the row's existing slots — kind, name, detail, status — without adding new elements to the conversation: the previous notification redesign was judged
 * “too ornate” on a real device precisely because it introduced new visual syntax.
 */
interface WorkflowDraftRowSlots {
  /** Detail slot: “Draft n.” */
  secondaryText: ReactNode | undefined;
  /** Status label “n issues to fix · not run,” present only when compilation fails. */
  statusLabel: ReactNode | undefined;
  /** Hollow ring before the status label, present only when compilation fails. */
  statusIndicator: ReactNode | undefined;
  /** Hover hint: the status sentence + diagnostics; present only when compilation fails. */
  statusTooltip: string | undefined;
  /** Draft number shown in the detail slot from draft 2 onward on an in-progress row (the card header while validating). */
  inFlightOrdinalText: string | undefined;
}

interface WorkflowDraftRowInput {
  draft: WorkflowDraftPosition | undefined;
  compileErrors: boolean;
  /** In-progress row (writing or awaiting confirmation): number from draft 2 onward; draft 1 should not imply there will be a draft 2. */
  inFlight: boolean;
  errorCount: number;
  diagnostics: readonly { line: number; column: number; message: string }[];
  saved: boolean;
}

export function useWorkflowDraftRowSlots({
  draft,
  compileErrors,
  inFlight,
  errorCount,
  diagnostics,
  saved,
}: WorkflowDraftRowInput): WorkflowDraftRowSlots {
  const { intl } = useZCodeIntl();
  const ordinal = workflowDraftOrdinalShown(draft, { compileErrors, inFlight });
  const inFlightOrdinal = workflowDraftOrdinalShown(draft, { compileErrors: false, inFlight });
  const inFlightOrdinalText =
    inFlightOrdinal === undefined
      ? undefined
      : intl.formatMessage(
          { id: "chat.toolCall.workflow.draftOrdinal" },
          { ordinal: String(inFlightOrdinal) },
        );
  const superseded = draft?.superseded === true;
  const lede = intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) });
  const words = compileErrors
    ? `${intl.formatMessage({ id: "chat.toolCall.workflow.toFix" }, { count: errorCount })} · ${intl.formatMessage({ id: "chat.toolCall.workflow.notRun" })}`
    : undefined;

  // ToolLayout is memoized: nodes passed to it must be memoized by value, or every parent render rerenders the entire row.
  const secondaryText = useMemo(
    () => (ordinal === undefined ? undefined : <WorkflowDraftOrdinal ordinal={ordinal} />),
    [ordinal],
  );
  const statusLabel = useMemo(
    () =>
      words === undefined ? undefined : <span data-testid="workflow-draft-status">{words}</span>,
    [words],
  );
  const statusIndicator = useMemo(
    () => (compileErrors ? <WorkflowDraftLamp superseded={superseded} /> : undefined),
    [compileErrors, superseded],
  );
  const statusTooltip = useMemo(
    () => (compileErrors ? formatWorkflowFeedbackTooltip(lede, diagnostics) : undefined),
    [compileErrors, diagnostics, lede],
  );
  return { secondaryText, statusLabel, statusIndicator, statusTooltip, inFlightOrdinalText };
}

/**
 * Expanded content for the feedback row: script (with line numbers; lines cited by diagnostics use warning color) and compile feedback card; fall back to
 * plain-text output when display is absent. The awaiting-confirmation row reuses this block (it has no diagnostics, only the script).
 */
export function WorkflowFeedbackContent({
  display,
  fallbackOutputText,
  saved,
  scriptText,
}: {
  display: ToolCallCreateWorkflowDisplay | null;
  fallbackOutputText: string | null;
  saved: boolean;
  scriptText: string | undefined;
}) {
  // Memoize by content: unchanged display keeps the same array, so injected code-block styles are not recreated.
  const flaggedLines = useMemo(
    () => (display?.ok === false ? workflowDiagnosticLines(display.diagnostics) : undefined),
    [display],
  );
  return (
    <div className="mb-2 space-y-3">
      {scriptText ? (
        <div data-testid="workflow-script-codeblock">
          <CodeBlock
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            code={scriptText}
            language="typescript"
            showLineNumbers
            {...(flaggedLines === undefined ? {} : { markedLines: flaggedLines })}
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="typescript" />
          </CodeBlock>
        </div>
      ) : null}
      {display && display.diagnostics.length > 0 ? (
        <WorkflowDiagnosticsSection
          count={display.errorCount}
          diagnostics={display.diagnostics}
          saved={saved}
          truncated={display.truncated}
        />
      ) : null}
      {!display && fallbackOutputText ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
          {fallbackOutputText}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Whether to show a draft number in the detail slot: always show it for failed rows (when the host provides a position); for in-progress rows, show it from draft 2 onward.
 * Run cards, launch summaries, and confirmation dialogs do not use this path and never show draft numbers.
 */
export function workflowDraftOrdinalShown(
  draft: WorkflowDraftPosition | undefined,
  phase: { compileErrors: boolean; inFlight: boolean },
): number | undefined {
  if (draft === undefined) return undefined;
  if (phase.compileErrors) return draft.ordinal;
  return phase.inFlight && draft.ordinal >= 2 ? draft.ordinal : undefined;
}

export function WorkflowDraftOrdinal({ ordinal }: { ordinal: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="workflow-draft-ordinal">
      {intl.formatMessage(
        { id: "chat.toolCall.workflow.draftOrdinal" },
        { ordinal: String(ordinal) },
      )}
    </span>
  );
}

/**
 * Hollow ring: its shape means “nothing ran,” and its color shows whether attention is still needed (warning color for the latest draft, then neutral after a newer draft).
 * `wf-lamp` transitions the color instead of switching abruptly.
 */
export function WorkflowDraftLamp({ superseded }: { superseded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp size-2 shrink-0 rounded-full",
        superseded ? DRAFT_FEEDBACK_DOT.settled : DRAFT_FEEDBACK_DOT.open,
      )}
      data-draft-lamp={superseded ? "settled" : "open"}
      data-testid="workflow-draft-lamp"
    />
  );
}
