import { PenIcon } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineHole } from "./timeline-holes.js";

/**
 * Small hole parts (docs/dynamic-workflow/presentation.md "Holes on the timeline"), shared by the card,
 * the side pane, and tool rows: the pen mark next to a station name after a phase-less fill (its head),
 * the waiting metadata word "waiting for fill", and the "{n} holes awaiting fill" chip in the run card
 * header and side pane.
 *
 * The hole's type (the T in `hole<T>`) **never appears in any UI**: it is a contract between the
 * compiler and the main agent, not something a user should read. In testing on 2026-09-28 it was
 * rendered as a monospace badge after the station name; raw text like
 * `{ target: string; reason: string }` filled the station head and squeezed the station name to zero
 * width — so only the name remains here.
 */
export function HoleFillMark({ className, holeId }: { className?: string; holeId: string }) {
  // The pen mark is the phase-less fill's head (presentation.md "Filled without phases"): when the
  // pointer lands on it, the timeline and side pane draw this station's frame (`data-fill-head`).
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground",
        className,
      )}
      data-fill-head={holeId}
      data-testid="workflow-hole-fill-mark"
    >
      <PenIcon aria-hidden className="size-2.5" />
    </span>
  );
}

/** "Waiting for fill" at the right of the station head: warning color, no wrap; appears only while the run is stopped at this hole. */
export function HoleWaitingMeta({ hole }: { hole: TimelineHole | undefined }) {
  const { intl } = useZCodeIntl();
  if (hole?.state !== "waiting") return null;
  return (
    <span
      className="shrink-0 whitespace-nowrap text-ui-xs text-warning"
      data-testid="workflow-hole-waiting"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waiting" })}
    </span>
  );
}

/** The same chip for the side pane's status header: reads the run's hole table directly and counts the waiting ones. */
export function RunHolesWaitingChip({
  run,
  testId,
}: {
  run: Pick<WorkflowRunState, "holes"> | undefined;
  testId: string;
}) {
  const count = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;
  return <HolesWaitingChip count={count} testId={testId} />;
}

/**
 * The "{n} holes awaiting fill" chip (run card header, side pane status header): pen icon, occupying
 * the question chip's slot; both chips can be present at once. Same face as the question chip
 * (warning 12% background, `text-ui-xs`); when clickable it opens the run details.
 */
export function HolesWaitingChip({
  count,
  onOpen,
  testId = "workflow-digest-holes",
}: {
  count: number;
  onOpen?: () => void;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  if (count <= 0) return null;
  const label = intl.formatMessage(
    {
      id:
        count === 1 ? "chat.toolCall.workflow.digest.hole" : "chat.toolCall.workflow.digest.holes",
    },
    { count },
  );
  const face =
    "wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning";
  return onOpen === undefined ? (
    <span className={face} data-testid={testId}>
      <PenIcon aria-hidden className="size-3" />
      {label}
    </span>
  ) : (
    <button
      className={cn(
        face,
        "cursor-pointer outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-testid={testId}
      onClick={onOpen}
      type="button"
    >
      <PenIcon aria-hidden className="size-3" />
      {label}
    </button>
  );
}
