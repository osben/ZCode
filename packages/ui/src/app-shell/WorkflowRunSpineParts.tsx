// ============================================================
// Parts of the side-panel spine.
// ============================================================
// Split out of WorkflowRunPhaseList.tsx (max-lines 400): the list file owns expanded state, question ownership, and pill wiring;
// this file contains four presentation-only parts—rail segment, lamp, avatars on collapsed phase headers, and rounds.

import { useId, useMemo, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowActorModelLabels } from "@/components/workflow-timeline/subagent-model-label.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import { StreamChevronsBox } from "@/components/workflow-timeline/WorkflowStreamChevrons.js";
import {
  SPINE_JOINT_PX,
  SPINE_TRACK_X,
  type SpineJoint,
  type SpineSection,
} from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Length of the main rail stub extending outside an open joint row (TAIL on the card). */
const SPINE_STUB_PX = 4;

/** Each half of a stream rail leaves this much space before/after a phase boundary for two downward chevrons. */
const SPINE_STREAM_GAP_PX = 7;

/** Maximum avatars shown on a collapsed phase header; the rest go into `+n`. */
const CLUSTER_MAX = 3;

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
export function SpineRail({
  ink,
  overhang,
  pitch,
  position,
  stream,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  /** One half of a stream rail: leaves `SPINE_STREAM_GAP_PX` at the phase boundary and does not overlay the transit light. */
  stream?: true;
  track?: number;
  /** Rail pitch (`workflowRunSpine.ts`); read only when track > 0. */
  pitch: number;
  /** Main rail in an open joint row: extends `SPINE_STUB_PX` outside the row—root above, sink below. */
  overhang?: "top" | "bottom";
}) {
  const x = SPINE_TRACK_X + pitch * track;
  const style: CSSProperties = {};
  // Stream-rail ink belongs on the chevrons; both rail halves remain a flat 1px line.
  const lit = ink === "march" && stream !== true;
  if (track > 0) style.left = lit ? x - 0.75 : x - 0.5;
  if (stream === true && position === "below") style.bottom = SPINE_STREAM_GAP_PX;
  if (stream === true && position === "above") {
    style.top = SPINE_STREAM_GAP_PX;
    style.height = 12 - SPINE_STREAM_GAP_PX;
  }
  if (overhang !== undefined) {
    style.top = overhang === "top" ? -SPINE_STUB_PX : 0;
    style.bottom = overhang === "bottom" ? -SPINE_STUB_PX : 0;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        lit ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        !lit && "bg-foreground-subtlest",
        lit && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-kind={stream === true ? "stream" : undefined}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * Draw all vertical rails for a phase (computed by `workflowRunSpine.ts`) at once. The lower half
 * of a stream rail places two downward chevrons in the center of the phase's bottom edge
 * (presentation.md, “The spine”); z-index 1 keeps the next phase header's hover background from covering them.
 */
export function SpinePieces({ pitch, section }: { pitch: number; section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} pitch={pitch} {...rail} />
      ))}
      {section.rails.map((rail) =>
        rail.stream === true && rail.position === "below" ? (
          <StreamChevronsBox
            count={2}
            direction="down"
            ink={rail.ink}
            key={`stream:${rail.track}`}
            style={{ left: SPINE_TRACK_X + pitch * rail.track, top: "100%", zIndex: 1 }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * Joint row (presentation.md, “The spine”): a branch or merge occupies a 16px row **between** two
 * phases. The main rail passes straight through; each branch leaves (or rejoins) the main rail on
 * the same y = 8 baseline: down, turn with radius min(6, pitch/2), move horizontally to its own
 * column, then turn and descend to the row bottom. With one branch, the two turns form an S. A merge
 * mirrors a branch.
 *
 * Draw every curve with base ink first. For transit, overlay a lit path on the same route
 * (`MarchLight`): fade in at the control-flow end and stay brightest at the lamp. The gradient ends
 * match the first and last points of the path; `useId()` gives each SVG a unique `id`.
 * In an open row (a branch without a predecessor or a merge without a merge station), the main rail
 * does not connect to the previous/next phase; it extends 4px outside the row and ends in a round
 * cap: a root or a sink (TAIL/STUB on the card). The whole row is decorative (`aria-hidden`); the
 * lamp and phase header already convey its meaning. If `joint` is absent, there is no joint here and nothing is drawn.
 */
export function SpineJointRow({
  joint,
  kind,
  pitch,
}: {
  joint: SpineJoint | undefined;
  kind: "fork" | "merge";
  pitch: number;
}) {
  const lightBase = useId();
  if (joint === undefined) return null;
  const main = SPINE_TRACK_X - 0.5;
  const r = Math.min(6, pitch / 2);
  const bus = SPINE_JOINT_PX / 2;
  const curves = joint.branches.map((branch) => {
    const x = main + pitch * branch.track;
    const d =
      kind === "fork"
        ? `M${main},0 V${bus - r} Q${main},${bus} ${main + r},${bus} H${x - r} Q${x},${bus} ${x},${bus + r} V${SPINE_JOINT_PX}`
        : `M${x},0 V${bus - r} Q${x},${bus} ${x - r},${bus} H${main + r} Q${main},${bus} ${main},${bus + r} V${SPINE_JOINT_PX}`;
    const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
    const to = kind === "fork" ? { x, y: SPINE_JOINT_PX } : { x: main, y: SPINE_JOINT_PX };
    return { ...branch, d, from, to };
  });
  const width = main + pitch * Math.max(1, ...joint.branches.map((branch) => branch.track)) + 8;
  return (
    <div
      aria-hidden
      className="relative shrink-0"
      data-joint-kind={kind}
      data-joint-open={joint.open === true ? "true" : undefined}
      data-testid="workflow-run-spine-joint"
      style={{ height: SPINE_JOINT_PX }}
    >
      <SpineRail
        ink={joint.main}
        pitch={pitch}
        position="full"
        {...(joint.open === true ? { overhang: kind === "fork" ? "top" : "bottom" } : {})}
      />
      <svg
        className="absolute left-0 top-0 overflow-visible"
        height={SPINE_JOINT_PX}
        viewBox={`0 0 ${width} ${SPINE_JOINT_PX}`}
        width={width}
      >
        {curves.map((curve) => (
          <g
            data-curve-ink={curve.ink}
            data-curve-track={curve.track}
            data-testid={`workflow-run-spine-${kind}`}
            key={curve.track}
          >
            <path
              className="wf-ink"
              d={curve.d}
              fill="none"
              stroke="var(--color-foreground-subtlest)"
              strokeLinecap="round"
              strokeWidth={1}
            />
          </g>
        ))}
        {/* Draw the glow above all base strokes: branches share a trunk, and a later base stroke must not cover an earlier branch’s glow. */}
        {curves.map((curve) =>
          curve.ink === "march" ? (
            <g data-testid={`workflow-run-spine-${kind}-lit`} key={`lit:${curve.track}`}>
              <MarchLight
                d={curve.d}
                from={curve.from}
                id={`${lightBase}lit-${curve.track}`}
                to={curve.to}
              />
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/**
 * Lamp on the rail: hollow = pending, green = complete, red with ring = failed, pulsing amber = running. The running lamp shares the card's
 * `wf-lamp-running` animation: constant glow plus a heartbeat; under `motion-reduce`, only the glow remains.
 */
export function SpineLamp({
  pitch,
  status,
  track = 0,
}: {
  status: StepRunStatus;
  track?: number;
  pitch: number;
}) {
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
      style={track === 0 ? undefined : { left: 16 + pitch * track }}
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

/**
 * Subagent row suffix: counts (“{n} tasks · {n} reads”), followed by the model name only when the
 * persona specifies one (presentation.md, “The spine”). Model names may be long (custom provider
 * “name/model”), so they yield along with the subagent name while the counts stay visible.
 */
export function SpinePillTrailer({
  counts,
  modelName,
}: {
  counts: readonly string[];
  modelName: string | undefined;
}) {
  return (
    <>
      {counts.length === 0 ? null : (
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {counts.join(" · ")}
        </span>
      )}
      {modelName === undefined ? null : (
        <span
          className="min-w-0 max-w-[45%] truncate font-mono text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-agent-model"
        >
          {counts.length === 0 ? modelName : `· ${modelName}`}
        </span>
      )}
    </>
  );
}

/** Memoize {@link workflowActorModelLabels} by the actors table and locale (the spine queries it on every rerender). */
export function useWorkflowActorModelLabels(
  actors: readonly { siteId: string; ordinal: number; model?: string }[] | undefined,
  providerName: ((providerId: string) => string | undefined) | undefined,
): ReadonlyMap<string, { name: string; canonical: string }> {
  const { intl } = useZCodeIntl();
  return useMemo(
    () =>
      workflowActorModelLabels(actors, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(providerName === undefined ? {} : { providerName }),
      }),
    [actors, intl, providerName],
  );
}
