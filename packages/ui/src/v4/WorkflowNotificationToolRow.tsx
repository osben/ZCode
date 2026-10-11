import { Hourglass, MessageCircleQuestion, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowNotificationMeta, WorkflowRunHole } from "@zcode/shared/zcode-protocol-v4";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import { WorkflowNotificationHoleRow } from "@/v4/WorkflowNotificationHoleRow.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";
import { WorkflowNotificationArtifactChips } from "@/v4/WorkflowNotificationArtifactChips.js";

/**
 * Background workflow notification row.
 *
 * The manifest-ledger design was rejected as "too flowery," so use the existing tool-card syntax:
 * notification rows share the same visual family as ordinary tool-call rows (ToolLayout: icon + kindLabel + primaryText + expanded body).
 * Data contracts, emitters, hydration, and pendingQuestions joins are unchanged; this is presentation only.
 *
 * Presentation only: the host resolves joins (onOpenRun / pendingQids) from the projection and passes them in; the component does not read the store,
 * making it testable with renderToStaticMarkup (expanded state is passed to ToolLayout through forceOpen).
 */

/** Base testid for the notification-row root. */
const TID_CHAT_WORKFLOW_NOTIFICATION_ROW = "chat-workflow-notification-row";

/** Single-line summary limit for the collapsed header, matching the escalation card: the summary says roughly what was asked; the expanded body shows the full text. */
const INLINE_PREVIEW_MAX_LENGTH = 160;

const TERMINAL_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;
const ESCALATION_ICON = (
  <MessageCircleQuestion className="size-4 shrink-0 text-foreground-subtle" />
);

/** Panel body (question/result prose), matching the border-border bg-panel convention in escalation/submit-result. */
const PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5";
/** Failure error panel, matching resolve-question outcome's border-destructive/40 convention (not a row-level failure treatment). */
const ERROR_PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground";

/** Collapse to a one-line summary: replace newlines with spaces and truncate long text (matching toInlinePreview in the escalation card). */
function toInlinePreview(value: string): string | undefined {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

const TERMINAL_KIND_LABEL_ID: Record<"completed" | "errored" | "stopped", string> = {
  completed: "chat.backgroundResult.workflow.completed",
  errored: "chat.backgroundResult.workflow.errored",
  stopped: "chat.backgroundResult.workflow.stopped",
};

/** kindLabel for a stalled row: the run is still active but has had no successful model request for 20 minutes. */
const STALL_KIND_LABEL_ID = "chat.backgroundResult.workflow.stall";
const STALL_ICON = <Hourglass className="size-4 shrink-0 text-foreground-subtle" />;

/** A `label: value` fact row in the expanded body (stall duration/reason/concurrency). */
function factLine(label: string, value: string, key: string) {
  return (
    <p key={key} className="text-ui-sm text-foreground-subtle">
      <span className="text-foreground-subtlest">{label}</span> {value}
    </p>
  );
}

/**
 * Three kindLabel states for escalation rows (live lookup by pendingQuestions presence, same logic as manifest):
 *   pendingQids contains qid → waiting (waiting for an answer);
 *   run is present and qid is absent → answered (the question was answered);
 *   run is absent (pendingQids === undefined) → asked (neutral: a question was raised).
 * No blinking or shimmer—shimmer means "actively working," while a raised question waits for the main agent.
 */
function escalationState(
  pendingQids: ReadonlySet<string> | undefined,
  qid: string,
): "waiting" | "answered" | "asked" {
  if (pendingQids === undefined) return "asked";
  return pendingQids.has(qid) ? "waiting" : "answered";
}

export interface WorkflowNotificationToolRowProps {
  notification: WorkflowNotificationMeta;
  /** Run name = originMeta.title (authoritative from CLI, not localized). */
  runName: string;
  /** testid suffix + ToolLayout persist key, taken from unit.key. */
  testIdKey: string;
  /** Application theme for CodeBlock (used for JSON results). */
  theme: Theme;
  /** Pre-bound callback to open run details; if unavailable, do not render the "Open run details" link in the expanded body. */
  onOpenRun?: () => void;
  /**
   * Pre-bound callback to open an artifact tab (injected by the host from the join, like `onOpenRun`). If absent, chips still render
   * but are not clickable—what was delivered is a fact; whether it can be opened is a capability.
   */
  onOpenArtifact?: (artifactId: string) => void;
  /** Presence join for escalation rows: undefined = run absent from the live projection; Set containing qid = Waiting; missing qid = Answered. */
  pendingQids?: ReadonlySet<string>;
  /** Force expanded state for tests/host (passed through to ToolLayout.forceOpen); collapsed by default in product. */
  forceOpen?: boolean;
  /**
   * Presence lookup for the hole row (docs/dynamic-workflow/transcript-and-notifications.md, “The
   * hole row's live state”): `holes` from the run projection; undefined means the run is absent from
   * the live projection (use neutral wording).
   */
  holes?: readonly WorkflowRunHole[];
}

export function WorkflowNotificationToolRow(props: WorkflowNotificationToolRowProps) {
  // Render hole rows separately (WorkflowNotificationHoleRow.tsx): they have their own three
  // states and expanded body. Putting them into the three branches below would add a “not a hole” check to each branch.
  if (props.notification.kind === "hole") {
    return (
      <WorkflowNotificationHoleRow
        forceOpen={props.forceOpen ?? false}
        holes={props.holes}
        notification={props.notification}
        runName={props.runName}
        toolId={`${TID_CHAT_WORKFLOW_NOTIFICATION_ROW}-${props.testIdKey}`}
        {...(props.onOpenRun === undefined ? {} : { onOpenRun: props.onOpenRun })}
      />
    );
  }
  return <WorkflowNotificationBaseRow {...props} notification={props.notification} />;
}

function WorkflowNotificationBaseRow({
  notification,
  runName,
  testIdKey,
  theme,
  onOpenRun,
  onOpenArtifact,
  pendingQids,
  forceOpen = false,
}: WorkflowNotificationToolRowProps & {
  notification: Exclude<WorkflowNotificationMeta, { kind: "hole" }>;
}) {
  const { intl } = useZCodeIntl();

  // Waiting duration must keep advancing without an event stream (a stalled run emits no events); provide a fresh "now" on a fixed interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openRunLink = onOpenRun ? (
    <button
      type="button"
      onClick={onOpenRun}
      className="text-ui-sm text-foreground-subtle decoration-dotted underline-offset-2 hover:text-foreground hover:underline"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
    </button>
  ) : null;

  const isEscalation = notification.kind === "escalation";
  const isStall = notification.kind === "stall";

  // Build kindLabel + primaryText + expanded body separately for the three notification types.
  const escalationView = isEscalation ? escalationState(pendingQids, notification.qid) : undefined;

  // For stopped runs, append the reason after kindLabel.
  const stopReason =
    notification.kind === "terminal" && notification.status === "stopped"
      ? notification.stopReason
      : undefined;
  const kindLabel = isEscalation
    ? intl.formatMessage({ id: `chat.backgroundResult.workflow.${escalationView!}` })
    : isStall
      ? intl.formatMessage({ id: STALL_KIND_LABEL_ID })
      : stopReason !== undefined
        ? `${intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] })} · ${intl.formatMessage({ id: `chat.toolCall.workflow.run.stopReason.${stopReason}` })}`
        : intl.formatMessage({ id: TERMINAL_KIND_LABEL_ID[notification.status] });

  const primaryText = useMemo(() => {
    if (notification.kind === "terminal" || notification.kind === "stall") {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{runName}</span>
        </span>
      );
    }
    const preview = toInlinePreview(notification.question);
    return <span className="min-w-0 truncate">{preview ?? runName}</span>;
  }, [notification, runName]);

  // Artifact chips at the end of the collapsed header.
  // Use ToolLayout's `secondaryText` slot with its existing `hideSecondaryTextWhenOpen` behavior—
  // show them only in the **collapsed header**; once expanded, the body already shows the result and the chips would be redundant.
  const artifactChips =
    notification.kind === "terminal" &&
    notification.artifacts !== undefined &&
    notification.artifacts.length > 0 ? (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <WorkflowNotificationArtifactChips
          artifacts={notification.artifacts}
          {...(notification.artifactsTruncated === undefined
            ? {}
            : { truncated: notification.artifactsTruncated })}
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      </span>
    ) : undefined;

  // Expanded content: terminal states show the artifact (error for errored/provider-stopped, otherwise result); escalation always shows the question,
  // and stalled rows always show wait facts.
  const hasDetails =
    notification.kind === "escalation" || notification.kind === "stall"
      ? true
      : notification.error !== undefined
        ? true
        : Boolean(notification.result);

  const waited =
    escalationView === "waiting" && notification.kind === "escalation"
      ? workflowRunQuestionWaitedLabel(notification.askedAt, now, (descriptor, values) =>
          intl.formatMessage(descriptor, values),
        )
      : undefined;

  const renderContent = useCallback(() => {
    if (notification.kind === "escalation") {
      const contextHeading = intl.formatMessage({ id: "chat.toolCall.workflow.escalate.context" });
      return (
        <div className="space-y-3">
          {/* Show the full question without quoting the answer; the answer is in the adjacent
              ResolveWorkflowQuestion card. */}
          <p className={`${PANEL_CLASS} text-foreground`}>{notification.question}</p>
          {notification.context !== undefined ? (
            <section className="space-y-1.5">
              <h4 className="text-ui-sm font-medium text-foreground-subtlest">{contextHeading}</h4>
              <p className={`${PANEL_CLASS} text-foreground-subtle`}>{notification.context}</p>
            </section>
          ) : null}
          {waited ? <p className="text-ui-sm text-foreground-subtle">{waited}</p> : null}
          {openRunLink}
        </div>
      );
    }

    if (notification.kind === "stall") {
      const minutes = Math.max(1, Math.round(notification.sinceMs / 60_000));
      return (
        <div className="space-y-1" data-testid="workflow-notification-stall">
          <p className={`${PANEL_CLASS} text-foreground`}>
            {intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.body" }, { minutes })}
          </p>
          {notification.reason !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.reason" }),
                notification.reason,
                "reason",
              )
            : null}
          {notification.cap !== undefined
            ? factLine(
                intl.formatMessage({ id: "chat.backgroundResult.workflow.stall.cap" }),
                String(notification.cap),
                "cap",
              )
            : null}
          {openRunLink}
        </div>
      );
    }

    // Errored, or stopped with error details (provider/interrupted): show the error panel.
    if (notification.error !== undefined) {
      return (
        <div className="space-y-3">
          <p className={ERROR_PANEL_CLASS}>{notification.error}</p>
          {openRunLink}
        </div>
      );
    }

    // completed/stopped: show only result (prose <p> / JSON CodeBlock, following submit-result convention).
    const { result, resultForm } = notification;
    let resultCode = result ?? "";
    if (resultForm === "json") {
      try {
        resultCode = JSON.stringify(JSON.parse(resultCode), null, 2);
      } catch {
        /* Preserve historical truncated JSON as-is; do not discard the result. */
      }
    }
    return (
      <div className="mb-2 min-w-0 space-y-2" data-testid="workflow-notification-result">
        {resultForm === "json" ? (
          <CodeBlock
            appTheme={theme}
            code={resultCode}
            language="json"
            className="border border-border bg-card"
            contentClassName="max-h-80 overflow-auto"
            wrapLongLines
          >
            <CodeBlockHeader className="pl-3 pr-2 pt-2" language="json" />
          </CodeBlock>
        ) : (
          <p className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-ui-base leading-relaxed text-foreground">
            {result}
          </p>
        )}
        {openRunLink}
      </div>
    );
  }, [notification, theme, waited, openRunLink, intl]);

  const toolId = `${TID_CHAT_WORKFLOW_NOTIFICATION_ROW}-${testIdKey}`;

  return (
    <div data-testid={toolId}>
      <ToolLayout
        toolId={toolId}
        persistOpenKey={toolId}
        icon={isEscalation ? ESCALATION_ICON : isStall ? STALL_ICON : TERMINAL_ICON}
        // kind already distinguishes the icon; showIcon defaults to visible.
        canToggle={hasDetails}
        forceOpen={forceOpen && hasDetails}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        primaryText={primaryText}
        secondaryText={artifactChips}
        // Important: **do not** use ToolLayout's failure-status treatment (that means "this call failed");
        // kindLabel communicates "workflow failed," and the expanded body shows error details. Do not set isRunning either (no shimmer).
        title={runName}
        renderContent={hasDetails ? renderContent : undefined}
      />
    </div>
  );
}
