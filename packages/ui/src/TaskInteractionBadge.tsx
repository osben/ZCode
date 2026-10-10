import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ZCodeTaskPendingInteraction } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

interface TaskInteractionBadgeProps {
  interaction?: ZCodeTaskPendingInteraction;
  legacyPending?: boolean;
  className?: string;
  /** Injected fake clock / SSR value; production defaults to the current absolute time. */
  now?: number;
  formatMessage: (id: string) => string;
  onSnoozeCountdown?: (interactionId: string) => boolean | Promise<boolean>;
}

interface TaskInteractionBadgePresentation {
  kind: "permission" | "userInput";
  countdownProgress?: number;
  canSnooze: boolean;
}

function isAskUserQuestionInteraction(
  interaction: ZCodeTaskPendingInteraction | undefined,
): boolean {
  if (!interaction || interaction.kind !== "userInput") return false;
  // Older sessions-index summaries do not include toolName; autoResolution applies only to a regular AskUserQuestion,
  // so it can serve as a compatibility check when restoring an older frame.
  return (
    interaction.toolName?.trim().toLowerCase() === "askuserquestion" ||
    interaction.autoResolution !== undefined
  );
}

function getTaskInteractionBadgePresentation(
  interaction: ZCodeTaskPendingInteraction | undefined,
  legacyPending: boolean,
  now: number,
): TaskInteractionBadgePresentation | null {
  if (!interaction) {
    return legacyPending ? { kind: "permission", canSnooze: false } : null;
  }
  if (!isAskUserQuestionInteraction(interaction)) {
    return { kind: "permission", canSnooze: false };
  }
  const autoResolution = interaction.autoResolution;
  if (!autoResolution) {
    // permission_requested and the durable autoResolution event may arrive in adjacent frames; when the tool identity is known,
    // show the Ask interaction consistently and allow the runtime to process the early pause intent idempotently.
    return { kind: "userInput", canSnooze: true };
  }
  if (autoResolution.state === "snoozed") {
    return { kind: "userInput", canSnooze: false };
  }
  if (now < autoResolution.visibleAt) {
    return { kind: "userInput", canSnooze: true };
  }
  const duration = Math.max(1, autoResolution.deadlineAt - autoResolution.visibleAt);
  const progress = Math.max(0, Math.min(1, (autoResolution.deadlineAt - now) / duration));
  return { kind: "userInput", countdownProgress: progress, canSnooze: true };
}

/** Blocking-interaction pill shared by regular, timeline, and grouped task rows. */
export function TaskInteractionBadge({
  interaction,
  legacyPending = false,
  className,
  now: injectedNow,
  formatMessage,
  onSnoozeCountdown,
}: TaskInteractionBadgeProps) {
  const [clockNow, setClockNow] = useState(Date.now);
  const snoozeRequestedInteractionIdRef = useRef<string | null>(null);
  const renderNow = injectedNow ?? clockNow;

  useEffect(() => {
    if (injectedNow !== undefined) return;
    // With reduced motion, do not animate continuously; when the window becomes active again, recalibrate once from the absolute deadline.
    const refresh = () => setClockNow(Date.now());
    // Cause: A task row usually outlives its pending interaction; when a new question or phase event arrives, reusing
    // the clock from when the row mounted could incorrectly treat visibleCountdown as still in its quiet period.
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    injectedNow,
    interaction?.interactionId,
    interaction?.autoResolution?.state,
    interaction?.autoResolution?.startedAt,
  ]);

  const presentation = getTaskInteractionBadgePresentation(interaction, legacyPending, renderNow);
  if (!presentation) return null;

  const label = formatMessage(
    presentation.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
  );
  const snoozeLabel = formatMessage("taskList.stopCountdown");
  const progress = presentation.countdownProgress;
  const autoResolution = interaction?.autoResolution;
  const remainingMs =
    progress !== undefined && autoResolution && autoResolution.state !== "snoozed"
      ? Math.max(0, autoResolution.deadlineAt - renderNow)
      : 0;
  const style =
    progress !== undefined
      ? ({
          "--zcode-interaction-progress": String(progress),
          "--zcode-interaction-remaining-ms": `${remainingMs}ms`,
        } as CSSProperties)
      : undefined;
  const canSnooze = presentation.canSnooze && Boolean(interaction) && Boolean(onSnoozeCountdown);
  const handleSnooze = () => {
    if (!canSnooze || !interaction || !onSnoozeCountdown) return;
    if (snoozeRequestedInteractionIdRef.current === interaction.interactionId) return;
    snoozeRequestedInteractionIdRef.current = interaction.interactionId;
    let snoozeRequest: boolean | Promise<boolean>;
    try {
      snoozeRequest = onSnoozeCountdown(interaction.interactionId);
    } catch {
      snoozeRequestedInteractionIdRef.current = null;
      return;
    }
    void Promise.resolve(snoozeRequest)
      .then((accepted) => {
        if (!accepted && snoozeRequestedInteractionIdRef.current === interaction.interactionId) {
          snoozeRequestedInteractionIdRef.current = null;
        }
      })
      .catch(() => {
        if (snoozeRequestedInteractionIdRef.current === interaction.interactionId) {
          snoozeRequestedInteractionIdRef.current = null;
        }
      });
  };

  const badgeContent = (
    <>
      {progress !== undefined ? (
        <span
          aria-hidden="true"
          className="zcode-task-interaction-countdown-fill absolute inset-0 origin-left bg-interaction-ask-fill transition-opacity group-hover/interaction-badge:opacity-0 group-focus-visible/interaction-badge:opacity-0 motion-reduce:transition-none"
        />
      ) : null}
      {canSnooze ? (
        <span aria-hidden="true" className="relative z-1 grid whitespace-nowrap">
          <span className="col-start-1 row-start-1 transition-opacity group-hover/interaction-badge:opacity-0 group-focus-visible/interaction-badge:opacity-0 motion-reduce:transition-none">
            {label}
          </span>
          <span className="col-start-1 row-start-1 opacity-0 transition-opacity group-hover/interaction-badge:opacity-100 group-focus-visible/interaction-badge:opacity-100 motion-reduce:transition-none">
            {snoozeLabel}
          </span>
        </span>
      ) : (
        <span className="relative z-1 whitespace-nowrap">{label}</span>
      )}
    </>
  );

  const badgeClassName = cn(
    // Permission requests and user questions use the same "waiting for confirmation" label; different colors would make the same state look inconsistent.
    "relative inline-flex h-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-transparent bg-interaction-confirmation-surface px-2 text-ui-sm font-medium text-interaction-confirmation-foreground",
    className,
  );

  if (canSnooze) {
    return (
      <button
        type="button"
        data-task-interaction-badge={presentation.kind}
        data-slot="badge"
        data-countdown-progress={progress?.toFixed(3)}
        data-countdown-snoozable="true"
        aria-label={snoozeLabel}
        className={cn(
          "group/interaction-badge cursor-pointer transition-colors hover:bg-secondary hover:text-foreground focus-visible:bg-secondary focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused motion-reduce:transition-none",
          badgeClassName,
        )}
        style={style}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleSnooze();
        }}
      >
        {badgeContent}
      </button>
    );
  }

  return (
    <span
      data-task-interaction-badge={presentation.kind}
      data-slot="badge"
      data-countdown-progress={progress?.toFixed(3)}
      className={badgeClassName}
      style={style}
    >
      {badgeContent}
    </span>
  );
}
