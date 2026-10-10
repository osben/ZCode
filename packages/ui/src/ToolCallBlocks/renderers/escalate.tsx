import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const ESCALATE_TOOL_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** Single-line summary limit for the collapsed header; it only says roughly what was asked, while the full question is in the expanded body. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/** Normalize input to an object when reading: for strings, try permissive `JSON.parse` **once** (following submit-result's read-side convention). */
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

/** Single-line summary for the collapsed header: replace newlines with spaces and truncate long text. */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * Escalate tool card. A subagent raises a **genuinely blocking** question to the main agent and waits
 * for an answer in this call. The nested read-only SessionPane in the main agent's side panel uses
 * the same ToolCallBlocks pipeline, so both surfaces share this card.
 *
 * Collapsed row: kindLabel (asking/asked) + one-line question summary. Expanded: question (+ context
 * if present) + answer area.
 *
 * Key point: a refusal because the budget is exhausted **is an ordinary tool result** (not an error
 * tool_result; see the handler comment), so never render the card as failed based on output text.
 * Only `status==="failed"` (for wiring failures, etc.) uses failure styling. While waiting (running),
 * the in-progress label is all the information available. This card may wait a long time, so the
 * running state should look calm rather than broken.
 */
export function EscalateToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const question = readText(input?.question);
  const questionContext = readText(input?.context);

  const isFailed = toolCall.status === "failed";
  // Waiting: still running / pending / in_progress and not failed — the answer has not arrived yet.
  const isAsking =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  // Answer text is model-facing content: the main agent's raw answer when answered, or port-provided
  // copy when refused. Both branches are ordinary results (handler formatModelContent returns only
  // message), so read them only from output.
  const answerText = isAsking ? undefined : readText(toolCall.output);

  const kindLabel = intl.formatMessage({
    id: isAsking
      ? "chat.toolCall.workflow.escalate.asking"
      : "chat.toolCall.workflow.escalate.asked",
  });
  const questionHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.question" });
  const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.answer" });
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.fallbackName" });

  const inlinePreview = useMemo(() => toInlinePreview(question), [question]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  // Expand when there is any expandable question, context, or answer. The first input frame may still
  // be `{}`; do not offer an expand control for an empty panel then (same streaming gate as submit-result).
  const hasDetails =
    question !== undefined || questionContext !== undefined || answerText !== undefined;

  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {question !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {question}
            </p>
          </section>
        ) : null}
        {questionContext !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle">
              {questionContext}
            </p>
          </section>
        ) : null}
        {answerText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answerText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [question, questionContext, answerText, questionHeading, contextHeading, answerHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={ESCALATE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
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
