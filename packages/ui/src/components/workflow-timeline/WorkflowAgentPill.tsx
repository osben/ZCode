import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LaneClass, StepRunStatus } from "@/components/workflow-graph/types.js";
import { WorkflowAgentFace, agentColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

export { agentColor, avatarColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

/**
 * Subagent pill: colored avatar +
 * name + status marker on the right. Used both under a card station and in a sidebar row; one pill represents the feature in both places.
 *
 * The avatar is a tile face (`WorkflowAgentFace`): body color comes from a nine-color cycle indexed by agent number, and expression reflects status.
 * A workspace has no identity, so it has no color and uses only a terminal glyph. `pending` is pixel-identical to no status (invariant 3):
 * no marker, a dimmed name, and a sleeping face.
 *
 * When openable (`open` is present), the entire pill is a button. Hover applies four effects together (raised background, avatar-hue
 * inner border, enlarged/darkened avatar, and ↗ replacing the status marker in the tail slot); click opens that subagent's transcript.
 * A non-openable pill has no hover state; `inertTitle` explains why.
 *
 * The tail slot (`wf-pill-tail`) is a shared 14px cell for the status marker and ↗. They overlap in the same cell; on hover the marker shrinks out
 * and the arrow shrinks in. Thus subagent and script status markers align on the same right edge, and ↗ never reserves its own space
 * (it cannot keep occupying space while hidden, or the subagent marker would sit one cell left of the workspace marker).
 */

/** Lane glyph: agent lanes use a tile face (number sets color, status sets expression); workspace/unresolved lanes use an icon. */
export function LaneGlyph({
  laneClass,
  className,
  avatarIndex,
  name,
  status,
}: {
  laneClass: LaneClass;
  className?: string;
  name: string;
  avatarIndex?: number | undefined;
  status?: StepRunStatus | undefined;
}) {
  if (laneClass === "agent") {
    return (
      <WorkflowAgentFace
        avatarIndex={avatarIndex}
        className={className}
        name={name}
        status={status}
      />
    );
  }
  const Glyph = laneClass === "workspace" ? TerminalIcon : CircleHelpIcon;
  return <Glyph aria-hidden className={className} />;
}

/** Status marker: spinner/check/cross; `pending` and undefined have no marker. A new marker pops in on status change; on an openable pill it yields to ↗ on hover. */
export function PillStatusMark({ status }: { status: StepRunStatus | undefined }) {
  const { intl } = useZCodeIntl();
  if (status === undefined || status === "pending") return null;
  const label = intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${status}` });
  return (
    <span
      aria-label={label}
      className={cn(
        "wf-mark flex size-3.5 shrink-0 items-center justify-center",
        // Use a neutral color for the running ring so normal loading is not mistaken for a warning.
        status === "running" && "text-foreground-subtle",
        status === "done" && "text-foreground-subtle",
        status === "failed" && "text-destructive",
      )}
      data-testid="workflow-pill-status"
      key={status}
      role="img"
      title={label}
    >
      {status === "running" ? (
        <LoaderCircleIcon
          aria-hidden
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      ) : status === "done" ? (
        <CircleCheckIcon aria-hidden className="size-3.5" />
      ) : (
        <CircleXIcon aria-hidden className="size-3.5" />
      )}
    </span>
  );
}

/** Wiring for an openable pill: click callback, accessibility label, and test/data attributes for ↗ (used by sidebar rows to identify the instance). */
export interface WorkflowAgentPillOpen {
  onOpen: () => void;
  label: string;
  testId?: string;
  data?: Record<`data-${string}`, string>;
}

export function WorkflowAgentPill({
  children,
  avatarIndex,
  className,
  enterDelayMs,
  inertTitle,
  laneClass,
  name,
  open,
  size = "md",
  status,
  title,
  trailing,
}: {
  avatarIndex?: number | undefined;
  /** Entrance delay (pills in a column arrive one by one, offset by 30 ms); absent means immediate. */
  enterDelayMs?: number;
  /** Localized display name (runtime name > lane display name). */
  name: string;
  laneClass: LaneClass;
  status: StepRunStatus | undefined;
  title?: string;
  className?: string;
  /** When present, the entire pill is a button (the callback's presence is the gate). */
  open?: WorkflowAgentPillOpen;
  /** Explanation when it cannot be opened ("A session record is available after the subagent starts"); otherwise, fall back to title/name. */
  inertTitle?: string;
  /** Extra information after the name and before the status marker (activity/counts in sidebar rows). */
  children?: ReactNode;
  /** Controls after the status marker. */
  trailing?: ReactNode;
  /** `row` (24px, no background at rest, pill shape on hover) is for two-column sidebar lists; default is 32px. */
  size?: "md" | "row";
}) {
  const tinted = laneClass === "agent";
  // Delayed entrances need backwards fill to keep the start frame during the wait; otherwise the pill appears fully visible before briefly restarting its entrance.
  // Do not use both: forwards would leave the transform on the element.
  const style = {
    ...(tinted ? { "--wf-avatar": agentColor(avatarIndex, name) } : {}),
    ...(enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" as const }),
  } as CSSProperties;
  const settled = status !== undefined && status !== "pending";
  const hasMark = settled;
  const hasTail = hasMark || open !== undefined;
  const Root = open === undefined ? "span" : "button";
  const body = (
    <>
      <LaneGlyph
        laneClass={laneClass}
        name={name}
        avatarIndex={avatarIndex}
        status={status}
        className={cn(
          "shrink-0",
          size === "row" ? "size-3.5" : "size-4",
          tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
        )}
      />
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          settled ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {name}
      </span>
      {children}
      {hasTail ? (
        <span
          className="wf-pill-tail grid size-3.5 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1"
          data-testid="workflow-pill-tail"
        >
          <PillStatusMark status={status} />
          {open === undefined ? null : (
            <span
              aria-hidden
              className="wf-pill-go flex size-3.5 items-center justify-center text-foreground-subtlest"
              data-testid={open.testId ?? "workflow-pill-open"}
              {...open.data}
            >
              <ArrowUpRightIcon className="size-3.5" />
            </span>
          )}
        </span>
      ) : null}
      {trailing}
    </>
  );
  return (
    <Root
      aria-label={open?.label}
      className={cn(
        "wf-pill wf-agent-pill wf-arrive flex rounded-full min-w-0 items-center",
        size === "row"
          ? "h-6 gap-1.5 pl-1 pr-1.5 text-ui-sm"
          : "h-8 gap-2 bg-surface pl-2 pr-2.5 text-ui-sm",
        open !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      data-agent-open={open === undefined ? undefined : "true"}
      data-agent-status={status ?? "pending"}
      data-pill-size={size}
      data-testid="workflow-agent-pill"
      onClick={open?.onOpen}
      style={style}
      title={open === undefined ? (inertTitle ?? title ?? name) : (title ?? name)}
      {...(open === undefined ? {} : { type: "button" as const })}
    >
      {body}
    </Root>
  );
}
