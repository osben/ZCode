import { MessageCircleQuestionIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * One escalation question, attached below the asker's row.
 *
 * **Read-only, with no reply box in v1**: the main agent answers, not the user — when it is unsure, it can already ask the user through AskUserQuestion.
 * qid is the token the main agent needs when answering; users cannot answer directly, but showing it lets them point
 * the main agent to a specific question — the only actionable handle in this read-only view.
 */
export function WorkflowRunQuestionRow({
  className,
  now,
  question,
  showAsker = false,
}: {
  /** Placement is supplied by the caller (on the spine, 26px below the asker; orphan blocks at the end indent themselves). */
  className?: string;
  /** “Now” from the directory timer so the waiting duration keeps advancing when no events arrive. */
  now: number;
  question: WorkflowRunPendingQuestion;
  /** Questions whose asker cannot be matched (attached to the end of the phase) include their own name; those attached below a row do not need it again. */
  showAsker?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(question.askedAt, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );

  return (
    <div
      className={cn(
        "mt-1 flex min-w-0 items-start gap-2 rounded-lg bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]",
        className,
      )}
      data-qid={question.qid}
      data-testid="workflow-run-question"
    >
      <MessageCircleQuestionIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {showAsker ? (
          <span className="mr-2 font-mono text-ui-xs font-medium">
            {question.actorName ??
              (question.actorSiteId === undefined
                ? intl.formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
                : `${question.actorSiteId}@${question.actorOrdinal}`)}
          </span>
        ) : null}
        {/* The question is readable prose, not a technical value, so use body-text styling; pre-wrap preserves line breaks the model may include. */}
        <span className="whitespace-pre-wrap break-words">{question.question}</span>
        {question.context === undefined ? null : (
          <p
            className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs opacity-80"
            data-testid="workflow-run-question-context"
          >
            {question.context}
          </p>
        )}
      </div>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-ui-xs">
        {/* Show how long it has been waiting. Deliberately do **not** use warning colors: a long wait is an expected state, not an alert. If askedAt
            is missing (replay from an older journal), render nothing; never invent a "just now" value. */}
        {waited === undefined ? null : (
          <span data-testid="workflow-run-question-waited">{waited}</span>
        )}
        <span className="opacity-70">{question.qid}</span>
      </span>
    </div>
  );
}
