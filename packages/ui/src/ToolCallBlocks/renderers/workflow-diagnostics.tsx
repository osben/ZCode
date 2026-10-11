import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** One TS diagnostic (CreateWorkflow and EvalWorkflowSnippet display share this shape). */
interface WorkflowDiagnosticEntry {
  line: number;
  column: number;
  code: number;
  message: string;
}

/**
 * Code range for analyzer-specific rules (starting at 9001).
 * Do not use "≥ 9000": TypeScript's own 18xxx codes (such as TS18048) are still TypeScript codes.
 * TypeScript uses 9xxx only for declaration-output diagnostics, and the workflow compiler does not
 * emit declarations, so this range belongs only to the analyzer on these cards.
 */
const ANALYZER_RULE_CODE_MIN = 9001;
const ANALYZER_RULE_CODE_MAX = 9099;

export function isWorkflowAnalyzerRuleCode(code: number): boolean {
  return code >= ANALYZER_RULE_CODE_MIN && code <= ANALYZER_RULE_CODE_MAX;
}

/**
 * Wording for the feedback card's single sentence: state what did not happen and who acts next.
 * A saved source that does not compile is a **file** problem, so the sentence names the file and
 * matches the wording given to the model in the tool result.
 * The card and row hover tooltip use the same id so they stay consistent.
 */
export function workflowFeedbackLedeMessageId(saved: boolean): string {
  return saved
    ? "chat.toolCall.workflow.feedback.lede.saved"
    : "chat.toolCall.workflow.feedback.lede";
}

/**
 * Compilation feedback card shared by CreateWorkflow and EvalWorkflowSnippet cards (same compiler
 * pipeline, diagnostic shape, and length limit; separate implementations would invite drift).
 *
 * A compile failure is not a run failure: nothing ran, and feedback went back to the model. Use a
 * neutral border and body foreground color, not destructive styling. In this feature, red is reserved
 * for failed runs; coloring the whole block red would make the least severe event the loudest thing
 * on the page. Render nothing when there are no diagnostics.
 */
export function WorkflowDiagnosticsSection({
  diagnostics,
  truncated,
  count,
  saved = false,
}: {
  diagnostics: readonly WorkflowDiagnosticEntry[];
  truncated?: boolean;
  /** Number of diagnostics; pass display.errorCount (total before truncation) when present, otherwise use the number of rows. */
  count?: number;
  /** Script came from a saved workflow file; the sentence names the file rather than this invocation. */
  saved?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (diagnostics.length === 0) {
    return null;
  }

  const total = count ?? diagnostics.length;
  const countLabel = intl.formatPlural({ id: "chat.toolCall.workflow.feedback.count" }, total);
  // Pass the code to ICU as a string; numeric arguments are localized with grouping ("9,003").
  const codeLabel = (code: number) =>
    isWorkflowAnalyzerRuleCode(code)
      ? intl.formatMessage({ id: "chat.toolCall.workflow.feedback.rule" }, { code: String(code) })
      : `TS${code}`;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-panel px-3 py-2"
      data-testid="workflow-compiler-feedback"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-ui-xs font-medium text-foreground-subtle">
        <span className="min-w-0 truncate" data-testid="workflow-compiler-feedback-title">
          {intl.formatMessage({ id: "chat.toolCall.workflow.feedback" })}
        </span>
        <span
          className="shrink-0 font-normal tabular-nums"
          data-testid="workflow-compiler-feedback-count"
        >
          {countLabel}
        </span>
      </div>
      <p
        className="text-ui-sm text-foreground-subtle"
        data-testid="workflow-compiler-feedback-lede"
      >
        {intl.formatMessage({ id: workflowFeedbackLedeMessageId(saved) })}
      </p>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.line}:${diagnostic.column}:${index}`}
          className="flex items-start gap-2 text-ui-base"
          data-testid="workflow-compiler-feedback-line"
        >
          <code className="shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            L{diagnostic.line}:C{diagnostic.column}
          </code>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
            {diagnostic.message}
          </span>
          <code className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
            {codeLabel(diagnostic.code)}
          </code>
        </div>
      ))}
      {truncated ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.workflow.truncated" })}
        </p>
      ) : null}
    </div>
  );
}
