import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelinePill, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";
import { ROSTER_PINS_CARD, rosterMore, stationRosterOf } from "./roster-model.js";
import { useTypewriter } from "./use-typewriter.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import { WorkflowMoreRow } from "./WorkflowMoreRow.js";
import {
  PILL_GAP,
  PILL_HEIGHT,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  timelineLayout,
  timelineWidth,
} from "./timeline-geometry.js";
import { WorkflowTimelineArcs } from "./WorkflowTimelineArcs.js";
import { WorkflowStationPlatform, WorkflowStationRow } from "./WorkflowTimelineStation.js";
import { WorkflowTimelineLamps, WorkflowTimelineTracks } from "./WorkflowTimelineTracks.js";
import {
  NO_FOLD,
  flightAfterScroll,
  foldStations,
  ledgeStubWidth,
  railKey,
  stationCameraLeft,
  timelineMaskStyle,
  type CameraFlight,
} from "./timeline-ledge.js";
import { useTimelineViewport } from "./use-timeline-viewport.js";
import {
  WorkflowLedge,
  WorkflowTimelineScrollbar,
  prefersReducedMotion,
} from "./WorkflowTimelineLedge.js";

export { STATION_GAP, STATION_PITCH, STATION_WIDTH, timelineWidth } from "./timeline-geometry.js";

/**
 * Horizontal timeline: one track, stations on the track,
 * pills hanging below stations, and arcs in the space above the track. Plain DOM plus one SVG layer (for arcs only), with no canvas library.
 *
 * Geometry constants match the design canvas exactly (`timeline-geometry.ts`): station width 168, spacing 24 (five stations = 936, fitting in the 960px
 * conversation column), track row 24, arc clearance 14. The dot sits in the pill avatar column (station left + 17), and the name in the subagent name column (station left + 34)
 *—the station header is itself a pill with no background.
 *
 * When wider than its container, the timeline scrolls freely: stations whose dots leave the viewport collapse into the **edge rails** on that side—the same dots, 16px each,
 * sitting on a clean base at the viewport edge. The track row fades out over 40px by the rail, and pills fade only at the actual viewport boundary; the position is shown by a 2px scrollbar at the bottom.
 * The native scrollbar is hidden, the right edge no longer has a gradient, and the header no longer needs a status band. The viewport stays centered on the running station; while the camera is moving, the target station does not collapse
 * (the viewport was measured before scrollTo, so treating it as outside the viewport based on stale coordinates during motion would be a false positive).
 *
 * Drafts (`model.draft`) are written by a pen: stations appear one at a time in declaration order, the track extends from the left,
 * the dot lands, and the name is written character by character; the cursor follows the pen and blinks when it catches up with the stream. Stations the pen has not reached are not on the track yet.
 */
function stationHeight(station: TimelineStation): number {
  // Stations past the threshold show five pinned pills plus an “n more” row: that row is the sixth pill,
  // so a station never has more than six pills.
  const roster = stationRosterOf(station, ROSTER_PINS_CARD);
  const n = roster === undefined ? station.pills.length : roster.pinned.length + 1;
  return n === 0 ? 0 : n * PILL_HEIGHT + (n - 1) * PILL_GAP;
}

/**
 * Overall timeline height (arc lane + track row + station row + tallest pill column). The outer frame transitions between two heights as the turn-tail summary expands/collapses,
 * so this must be computable outside render—the row layout is therefore a pure function in `timeline-geometry.ts`. The final 8px of bottom padding houses the scrollbar (6px below pills, a 2px track,
 * 4px on hover); it overlays that padding at the bottom edge without changing the height.
 */
export function timelineHeight(model: WorkflowTimelineModel): number {
  const rows = timelineLayout(model.arcs, model.bands);
  return rows.pillsTop + Math.max(0, ...model.stations.map(stationHeight)) + 8;
}

/** Delay between pills landing in sequence (same value as the design canvas). */
export const PILL_STAGGER_MS = 30;

function pillName(pill: TimelinePill, format: Parameters<typeof laneDisplayName>[1]): string {
  return pill.runtimeName ?? laneDisplayName(pill.lane, format);
}

export interface WorkflowTimelineProps {
  model: WorkflowTimelineModel;
  className?: string;
  /** Select a station; if absent, the station header is not a control and clicks bubble to the host (the turn-tail summary’s whole-area toggle). */
  onSelectStation?: (station: TimelineStation) => void;
  /**
   * The roster station’s “n more” row: open run details and jump to this station. It has a separate gate from the station header’s
   * `onSelectStation`: in the turn-tail summary, the header remains part of the whole-area toggle,
   * while this row is a separate entry point. Without this callback, the row is static.
   */
  onOpenMore?: (station: TimelineStation) => void;
  /** Click a pill (opens its transcript when a session exists; otherwise opens a placeholder); without a handler, it is not clickable. */
  onOpenPill?: (pill: TimelinePill) => void;
  /**
   * Click a script pill to open the full run’s script transcript
   * at this station; without a handler, the script pill is not clickable. Its lane is gated independently from `onOpenPill`.
   */
  onOpenWorkspace?: (pill: TimelinePill) => void;
}

export const WorkflowTimeline = memo(function WorkflowTimeline({
  className,
  model,
  onOpenMore,
  onOpenPill,
  onOpenWorkspace,
  onSelectStation,
}: WorkflowTimelineProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const markerId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the scroll-layer element in state too: the first draft frame returns null when n === 0, and the scroll layer mounts one frame later—the viewport hook depends on the element,
  // so it can attach its listener when the element appears (depending on the ref object would leave it stuck with the initial null).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  // Track one camera flight: record it on takeoff, clear it on landing or when the user takes over; the target station does not collapse while in flight.
  const [flight, setFlight] = useState<CameraFlight | undefined>(undefined);

  const { arcs } = model;
  const draft = model.draft !== undefined;
  const fullNames = model.stations.map((station) => phaseDisplayName(station.naming, format));
  const pen = useTypewriter(draft ? fullNames : undefined);
  const stations = draft ? model.stations.slice(0, pen.visible) : model.stations;
  const n = stations.length;
  const rails = draft ? model.rails.filter((rail) => rail.to < n) : model.rails;
  // Row layout: when a band is present, the main line sits on the bottom
  // row, branches stack above it, and station headers move to the station row. Without a band, the whole layout returns pixel-for-pixel to the previous “arc lane + track row”,
  // and uses the original DOM branch.
  const layout = timelineLayout(model.arcs, model.bands);
  const { banded, inset, pillsTop } = layout;
  const top = layout.rowY[0]! - RAIL_ROW / 2;
  const width = timelineWidth(n, inset);
  const height = timelineHeight(draft ? { ...model, stations } : model);
  // Pills land from left to right by station, and top to bottom within a station: pill k is delayed by k × 30 ms (the “n more” row is queued too).
  let pillOrdinal = 0;
  const nextDelay = () => {
    const delay = PILL_STAGGER_MS * pillOrdinal;
    pillOrdinal += 1;
    return delay;
  };
  // Resolve track segments by **station pair**: a station in the band can simultaneously have a main-line segment,
  // a branch segment, and a double-line segment.
  const railByPair = useMemo(
    () => new Map(rails.map((rail) => [railKey(rail.from, rail.to), rail])),
    [rails],
  );

  // Viewport state: scroll position, viewport width, and content width. If these cannot be measured (jsdom), all three are 0 and nothing below is collapsed.
  const viewport = useTimelineViewport(scroller, width);
  // After each scroll sample, settle the camera flight: it ends on landing or deviation. Position alone determines this; no timer is used.
  useEffect(() => {
    setFlight((current) => flightAfterScroll(current, viewport.scrollLeft));
  }, [viewport.scrollLeft]);
  const overflow = viewport.clientWidth > 0 && viewport.scrollWidth > viewport.clientWidth;
  const fold = overflow
    ? foldStations(n, viewport.scrollLeft, viewport.clientWidth, flight?.index, inset)
    : NO_FOLD;
  const folded = useMemo(() => new Set([...fold.left, ...fold.right]), [fold]);
  // Two mask bands: the track band fades beside the rails, while the pill band fades only at the actual viewport boundary.
  const mask = overflow
    ? timelineMaskStyle(fold, pillsTop - 8, {
        left: viewport.scrollLeft > 0,
        right: viewport.scrollLeft < viewport.scrollWidth - viewport.clientWidth - 1,
      })
    : undefined;

  const scrollTo = useCallback((left: number) => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, []);
  // Rail dot: the camera brings its station back to the center (same rule as the camera for the running station).
  const selectFolded = useCallback(
    (index: number) =>
      scrollTo(stationCameraLeft(index, scrollRef.current?.clientWidth ?? 0, inset)),
    [inset, scrollTo],
  );
  // When focus is on a station header or rail dot, ← and → scroll by one station.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-testid='workflow-timeline-station'], .wf-ledge") === null) return;
      const element = scrollRef.current;
      if (element === null || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      scrollTo(element.scrollLeft + (event.key === "ArrowLeft" ? -STATION_PITCH : STATION_PITCH));
    },
    [scrollTo],
  );

  // Camera: when wider than its container, scroll the focused station into view; after user scrolling, stop taking over and re-anchor only when the focused station changes.
  // In a run, focus is the running station (centered); in a draft, focus follows the pen—the newest revealed station stays at the right edge.
  // Draft landing position is index·PITCH + STATION_WIDTH − clientWidth: do not add another station spacing (that overshoots by 24px and only lands correctly through browser clamping).
  const focusIndex = draft ? (n > 0 ? n - 1 : undefined) : model.runningIndex;
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || focusIndex === undefined) return;
    if (element.scrollWidth <= element.clientWidth) return;
    const left = draft
      ? Math.max(0, stationX(focusIndex, inset) + STATION_WIDTH - element.clientWidth)
      : stationCameraLeft(focusIndex, element.clientWidth, inset);
    // Takeoff: clamp the target to the scrollable range; if already at the target, there is no flight.
    const target = Math.min(left, element.scrollWidth - element.clientWidth);
    const from = element.scrollLeft;
    setFlight(Math.abs(from - target) <= 1 ? undefined : { from, index: focusIndex, target });
    element.scrollTo({ behavior: prefersReducedMotion() ? "auto" : "smooth", left });
  }, [draft, focusIndex, inset]);

  if (n === 0) return null;

  const stationTitleOf = (phaseId: string): string => {
    const station = model.stations.find((candidate) => candidate.id === phaseId);
    return station === undefined ? phaseId : phaseDisplayName(station.naming, format);
  };
  const stationTitle = (station: TimelineStation): string => {
    const name = phaseDisplayName(station.naming, format);
    return station.onLoop && station.rounds > 0
      ? `${name} · ${intl.formatMessage({ id: "chat.toolCall.workflow.timeline.rounds" }, { count: station.rounds })}`
      : name;
  };

  const renderPill = (pill: TimelinePill) => {
    const enterDelayMs = nextDelay();
    const label = pillName(pill, format);
    // All subagent pills in a live run are openable: those with a session open its transcript; those not yet started
    // open a placeholder in the same tab, using slot identity (`pill.slot`) as the handle. Without a run, there is no slot.
    // Script pills use the same open behavior: when a live run provides a handle, open the first card at this station.
    // They have no hue, so hover border falls back to border-hover (the pill's own rule).
    const open =
      onOpenPill !== undefined && pill.slot !== undefined
        ? {
            label: format({ id: "chat.toolCall.workflow.timeline.openAgent" }, { name: label }),
            onOpen: () => onOpenPill(pill),
            testId: "workflow-timeline-pill-open",
          }
        : onOpenWorkspace !== undefined && pill.workspace !== undefined
          ? {
              label: format(
                { id: "chat.toolCall.workflow.timeline.openScript" },
                { phase: stationTitleOf(pill.workspace.phaseId) },
              ),
              onOpen: () => onOpenWorkspace(pill),
              testId: "workflow-timeline-workspace-open",
            }
          : undefined;
    return (
      <WorkflowAgentPill
        enterDelayMs={enterDelayMs}
        key={pill.key}
        avatarIndex={pill.avatarIndex}
        laneClass={pill.laneClass}
        name={label}
        status={pill.status}
        {...(open === undefined ? {} : { open })}
      />
    );
  };

  const ledgeProps = {
    nameOf: (index: number) => fullNames[index]!,
    onSelect: selectFolded,
    rails: railByPair,
    stations,
    top,
  };

  return (
    <div
      className={cn("wf-motion wf-timeline min-w-0", className)}
      data-testid="workflow-timeline"
      onKeyDown={onKeyDown}
    >
      {/* The eave and scrollbar overlay the scrolling layer; position them relative to it rather than the padded outer frame. */}
      <div className="relative">
        <div
          className="wf-scroller overflow-x-auto overflow-y-hidden"
          data-testid="workflow-timeline-scroller"
          data-timeline-fade={
            fold.left.length > 0 && fold.right.length > 0
              ? "both"
              : fold.left.length > 0
                ? "left"
                : fold.right.length > 0
                  ? "right"
                  : undefined
          }
          ref={attachScroller}
          style={mask}
        >
          <div className="relative" style={{ height, width }}>
            <WorkflowTimelineArcs
              arcs={arcs}
              bands={model.bands}
              height={height}
              layout={layout}
              markerId={markerId}
              stations={model.stations}
              width={width}
            >
              {/* When a band is present, render the track in this SVG layer too; branches and joins are curves that DOM borders cannot draw. */}
              {banded ? (
                <WorkflowTimelineTracks
                  folded={folded}
                  layout={layout}
                  model={{ bands: model.bands, rails, stations }}
                />
              ) : null}
            </WorkflowTimelineArcs>

            {banded ? (
              <WorkflowTimelineLamps
                draft={draft}
                folded={folded}
                layout={layout}
                stations={stations}
              />
            ) : null}

            {banded ? (
              <WorkflowStationPlatform
                folded={folded}
                fullNames={fullNames}
                layout={layout}
                stations={stations}
                titleOf={stationTitle}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            ) : (
              <WorkflowStationRow
                draft={draft}
                folded={folded}
                fullNames={fullNames}
                pen={pen}
                rails={railByPair}
                stations={stations}
                titleOf={stationTitle}
                top={top}
                width={width}
                {...(onSelectStation === undefined ? {} : { onSelectStation })}
              />
            )}

            {stations.map((station, i) => {
              const roster = stationRosterOf(station, ROSTER_PINS_CARD);
              // When a roster exists, keep its summary: if every pill at a station was evicted by the cap, the "N more" row remains instead of disappearing.
              if (station.pills.length === 0 && roster === undefined) return null;
              return (
                <div
                  className="absolute flex flex-col"
                  data-station-roster={roster === undefined ? undefined : "true"}
                  data-testid="workflow-timeline-pills"
                  key={station.id}
                  style={{
                    gap: PILL_GAP,
                    left: stationX(i, inset),
                    top: pillsTop,
                    width: STATION_WIDTH,
                  }}
                >
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    // Roster station: the five pinned pills reuse pill wiring, followed by an "N more" row.
                    // Clicking it opens run details and selects this station (`onOpenMore`, its own door).
                    <>
                      {roster.pinned.map(renderPill)}
                      <WorkflowMoreRow
                        enterDelayMs={nextDelay()}
                        more={rosterMore(roster)}
                        {...(onOpenMore === undefined ? {} : { onOpen: () => onOpenMore(station) })}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {/* Edge eaves: stations folded to either side of the viewport, with a row of lights on the track row; the content beneath the eave has been masked out. */}
        <WorkflowLedge
          indexes={fold.left}
          side="left"
          stubWidth={ledgeStubWidth(fold, "left", viewport.scrollLeft, viewport.clientWidth, inset)}
          {...ledgeProps}
        />
        <WorkflowLedge
          indexes={fold.right}
          side="right"
          stubWidth={ledgeStubWidth(
            fold,
            "right",
            viewport.scrollLeft,
            viewport.clientWidth,
            inset,
          )}
          {...ledgeProps}
        />
        {overflow ? <WorkflowTimelineScrollbar scrollRef={scrollRef} viewport={viewport} /> : null}
      </div>
    </div>
  );
});
