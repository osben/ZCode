import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SUBMIT_RESULT_TOOL_ICON = (
  <ClipboardCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** Single-line summary limit for the collapsed header: it only says roughly what was submitted; the full content is in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Normalize submitted content at read time: for strings, try a lenient `JSON.parse` **once** and use the parsed value only for objects/arrays.
 *
 * This mirrors an observed engine-side behavior on reads — `engine/scheduler.ts` records that “real models often serialize result as
 * a JSON string” and applies the same one-time lenient parse. Do not recursively parse multiple layers (the engine also parses only once); treat parse failures as
 * strings, never throw and break the card, and never rewrite any data.
 */
function normalizeSubmittedResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    // Preserve literal strings containing numbers / booleans / null: those are model-authored text, not structured payloads.
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/** Indented text for the JSON branch. Fall back to `String(...)` for malformed payloads such as circular references; payloads must not crash the card. */
function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Single-line summary for the collapsed header: collapse newlines to spaces and truncate if too long. */
function toInlinePreview(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

export function SubmitResultToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  // Same fix rationale as send-message: input may still be `{}` on the first streaming frame, so do not provide
  // an expand control for an empty panel. Gate on the presence of the `result` key, not on “result has a value” — submitting null is still a real submission.
  const hasResult = input !== undefined && "result" in input;
  const normalizedResult = useMemo(
    () => (hasResult ? normalizeSubmittedResult(input?.result) : undefined),
    [hasResult, input?.result],
  );
  const isProse = typeof normalizedResult === "string";

  const isRejected = toolCall.status === "failed";
  // Rejected and stopped cards say the same thing: submission did not complete. The spec defines only four phases; do not invent a fifth label for denied.
  const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";
  const isSubmitting =
    !isRejected &&
    !isStopped &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");
  const kindLabelId = isRejected
    ? "chat.toolCall.submitResult.rejected"
    : isStopped
      ? "chat.toolCall.submitResult.stopped"
      : isSubmitting
        ? "chat.toolCall.submitResult.submitting"
        : "chat.toolCall.submitResult.submitted";

  // Original rejection text: prefer the error channel, then the tool's own error field and plain-text output. Accepted output is always
  // “The result was accepted.” and contains no information, so never read it.
  const rejectionText = isRejected
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : undefined;
  // Rejected state is a flat row with no expand control; show the original rejection in the failure tooltip (copyable on hover), without a field-by-field
  // violations panel. rejectionText exists only in rejected state, so other states gate expansion only on the presence of the result key.
  const hasDetails = !isRejected && hasResult;

  const resultLabel = intl.formatMessage({ id: "chat.toolCall.submitResult.resultHeading" });
  const inlinePreview = useMemo(
    () => (hasResult ? toInlinePreview(normalizedResult) : undefined),
    [hasResult, normalizedResult],
  );
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? "submit_result"}</span>
    ),
    [inlinePreview, toolCall.title],
  );

  const theme = context.theme;
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {hasResult ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{resultLabel}</h4>
            {isProse ? (
              // Human-readable text is prose: DESIGN.md reserves monospace for paths/commands/code/identifiers/terminal data.
              // Deliberately do not render markdown — result strings have no markdown contract.
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
                {normalizedResult as string}
              </p>
            ) : (
              // Structured payloads use CodeBlock (respecting the user's code font-size setting); the container matches mcp.tsx exactly.
              <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <CodeBlock
                  appTheme={theme}
                  code={stringifyResult(normalizedResult)}
                  language="json"
                />
              </div>
            )}
          </section>
        ) : null}
      </div>
    ),
    [hasResult, isProse, normalizedResult, resultLabel, theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SUBMIT_RESULT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isRejected ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isRejected ? rejectionText : undefined}
        showFailureStatus={isRejected}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
