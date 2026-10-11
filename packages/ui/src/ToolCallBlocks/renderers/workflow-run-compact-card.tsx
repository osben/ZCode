import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // The card itself has role=button, so closest would match the card from anywhere inside it and
  // "click card to open details" would never run (the original plan-card bug). Intercept only actual child controls.
  return interactive !== null && interactive !== card;
}

/**
 * Compact, clickable card for a workflow run — the shared "run-state third state" for CreateWorkflow
 * and ResumeWorkflowRun tool cards.
 *
 * The whole card is the entry point (semantic colors from DESIGN.md + the existing run-state
 * vocabulary). Discoverability testing failed because the entry had been hidden inside the expanded
 * card body. Callers change only labelText and primaryText (create uses the workflow name, resume
 * uses runId); status text and step count are driven by the live joined summary.
 *
 * Without `onOpen`, the card is display-only: no role/tabIndex/hover. The host injects the callback
 * only when a run can actually be opened (the gate in `ToolCallBlockRenderContext.onOpenWorkflowRun`).
 */
export function WorkflowRunCompactCard({
  ariaLabel,
  icon,
  labelText,
  primaryText,
  primaryTitle,
  workflowRun,
  statusLabel,
  stepsLabel,
  onOpen,
  showIcon,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  labelText: string;
  primaryText: string;
  primaryTitle?: string;
  workflowRun: WorkflowRunCardSummary;
  statusLabel: string;
  stepsLabel: string;
  onOpen: (() => void) | undefined;
  showIcon: boolean;
  /** Additional content beneath the card (such as ToolSnapshotFieldNotice), rendered with the card. */
  children?: ReactNode;
}) {
  // Whole-card click / Enter / Space — follow the plan-card pattern in switch-mode.tsx, including
  // the reasons for both guards: the card itself has role=button, so the check must exclude the card
  // itself or "click card to open details" never runs; keydown from child controls also bubbles to
  // the card, causing one keyboard action to open the details page twice.
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (!isInteractiveDescendant(event.target, event.currentTarget)) onOpen();
  };
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <>
      <section
        aria-label={ariaLabel}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-card-border bg-card px-3 py-2.5 text-foreground shadow-xs outline-none transition-colors",
          onOpen
            ? "hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
            : undefined,
        )}
        data-testid="workflow-run-card"
        data-workflow-run-id={workflowRun.runId}
        data-workflow-run-status={workflowRun.status}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        {showIcon ? icon : null}
        <span className="shrink-0 text-ui-base font-medium text-foreground-subtle">
          {labelText}
        </span>
        {/* The workflow name is a UI heading; use the default font so it does not look like monospace code. */}
        <span
          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtlest"
          title={primaryTitle ?? primaryText}
        >
          {primaryText}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Keep the status text next to the dot; never convey status through color or animation alone. */}
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[workflowRun.status])}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT[workflowRun.status])}>
            {statusLabel}
          </span>
        </span>
        {/* Step count means "how many scheduled steps have settled," not overall progress; dynamic workflows have no fixed total. */}
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {stepsLabel}
        </span>
      </section>
      {children}
    </>
  );
}
