// ============================================================
// Parts of the side-panel spine.
// ============================================================
// Split out of WorkflowRunPhaseList.tsx (max-lines 400): the list file owns expanded state, question ownership, and pill wiring;
// this file contains four presentation-only parts—rail segment, lamp, avatars on collapsed phase headers, and rounds.

import { useId, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import type { SpineSection } from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Maximum avatars shown on a collapsed phase header; the rest go into `+n`. */
const CLUSTER_MAX = 3;

/** Center of the vertical rail at t; main rail is at 21, with each branch shifted right by 12px (`workflowRunSpine.ts`). */
const TRACK_X = 21;
const TRACK_GAP = 12;

/**
 * One half of a rail segment. Draw the segment between adjacent stations in two pieces: from the bottom of the lamp to the bottom of the previous station,
 * then from the top of the next station to the top of its lamp. Both pieces use the same ink and meet at the station boundaries.
 * This lets the rail expand/collapse with each section without measuring its height.
 *
 * Bands have a third type: `full` passes through the whole station (main rail through a branch station, branch rail through another station); `from` / `to` leave 13px
 * for branch/merge curves. Rails with t > 0 get their x value inline because it is calculated and cannot be expressed as a Tailwind class.
 *
 * The moving segment (`march`) is a stationary 1.5px **lit** rail: it marks the edge control flow has traversed, while animation belongs to
 * the active lamp. Brightness increases in the direction of control flow—`data-rail-position` selects the CSS gradient, so both pieces need it:
 * `below` (bottom half of the previous station) fades from transparent to 70% warning color; `above` (top half of the running station) rises from 70% to full,
 * continuing into the lamp; `full` stays at 70% throughout.
 */
function SpineRail({
  from,
  ink,
  position,
  to,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  track?: number;
  from?: number;
  to?: number;
}) {
  const style: CSSProperties = {};
  if (track > 0)
    style.left = (ink === "march" ? TRACK_X - 0.75 : TRACK_X - 0.5) + TRACK_GAP * track;
  if (from !== undefined) style.top = from;
  if (to !== undefined) style.bottom = to;
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        ink === "march" ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        ink !== "march" && "bg-foreground-subtlest",
        ink === "march" && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * Branch/merge curves: the branch rail leaves the main rail within the 13px above the band's first station and returns with a mirrored curve at the merge station's top (or the band's last station's bottom).
 * Use the same drawing for muted and bright rails (as for vertical rails); while active, overlay the same path with a lit gradient
 * (`MarchLight`) that fades in from the control-flow side and is brightest at the lamp. Gradient endpoints are the two points used to draw the `path`
 * (branch from main-rail top to branch-rail bottom; merge is reversed); do not parse the path string. `id` uses `useId()` to remain unique within an SVG.
 */
function SpineCurve({
  at,
  ink,
  kind,
  track,
}: {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  at: "top" | "bottom";
}) {
  const lightId = useId();
  const x = TRACK_X - 0.5 + TRACK_GAP * track;
  const main = TRACK_X - 0.5;
  const path =
    kind === "fork"
      ? `M${main},0 V1 C${main},8 ${x},5 ${x},13`
      : `M${x},0 C${x},8 ${main},5 ${main},13`;
  const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
  const to = kind === "fork" ? { x, y: 13 } : { x: main, y: 13 };
  const width = x + 8;
  return (
    <svg
      aria-hidden
      className={cn("absolute left-0", at === "top" ? "top-0" : "bottom-0")}
      data-curve-ink={ink}
      data-curve-track={track}
      data-testid={`workflow-run-spine-${kind}`}
      height={13}
      viewBox={`0 0 ${width} 13`}
      width={width}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--color-foreground-subtlest)"
        strokeLinecap="round"
        strokeWidth={1}
      />
      {ink === "march" ? <MarchLight d={path} from={from} id={lightId} to={to} /> : null}
    </svg>
  );
}

/** Draw all vertical rails and curves for one station in one pass (calculated by `workflowRunSpine.ts`). */
export function SpinePieces({ section }: { section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} {...rail} />
      ))}
      {section.curves.map((curve) => (
        <SpineCurve key={`${curve.kind}:${curve.track}`} {...curve} />
      ))}
    </>
  );
}

/**
 * Lamp on the rail: hollow = pending, green = complete, red with ring = failed, pulsing amber = running. The running lamp shares the card's
 * `wf-lamp-running` animation: constant glow plus a heartbeat; under `motion-reduce`, only the glow remains.
 */
export function SpineLamp({ status, track = 0 }: { status: StepRunStatus; track?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full",
        STATUS_DOT[status],
        status === "pending" && "bg-background",
        status === "running" && "wf-lamp-running motion-reduce:animate-none",
      )}
      data-lamp={status}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + TRACK_GAP * track }}
    />
  );
}

/** Avatar strip on a collapsed phase header: see who is at the station. Subagents use numbered colored tile faces; workspace uses a terminal glyph. */
export function AvatarCluster({
  pills,
  nameOf,
}: {
  pills: readonly TimelinePill[];
  nameOf: (pill: TimelinePill) => string;
}) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, CLUSTER_MAX);
  const more = pills.length - shown.length;
  return (
    <span className="flex items-center gap-1" data-testid="workflow-run-phase-cluster">
      {shown.map((pill) => {
        const tinted = pill.laneClass === "agent";
        const color = tinted ? agentColor(pill.avatarIndex, nameOf(pill)) : undefined;
        return (
          <span
            className={cn(
              "contents",
              tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
            )}
            key={pill.key}
            style={color === undefined ? undefined : { ["--wf-avatar" as string]: color }}
            title={nameOf(pill)}
          >
            <LaneGlyph
              className="size-4 shrink-0"
              avatarIndex={pill.avatarIndex}
              laneClass={pill.laneClass}
              name={nameOf(pill)}
              status={pill.status}
            />
          </span>
        );
      })}
      {more > 0 ? (
        <span className="ml-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** Round count: `⟳ n`, shown only at both ends of a back edge after at least one round (same rule as the card). */
export function Rounds({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  if (!station.onLoop || station.rounds === 0) return null;
  return (
    <span
      className="flex items-center gap-[3px]"
      data-testid="workflow-run-phase-rounds"
      title={intl.formatMessage(
        { id: "chat.toolCall.workflow.timeline.rounds" },
        { count: station.rounds },
      )}
    >
      <Repeat2Icon aria-hidden className="size-[11px]" />
      <span>{station.rounds}</span>
    </span>
  );
}
