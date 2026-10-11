import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  TAIL_STUB,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { HoleFillMark, HoleWaitingMeta } from "./WorkflowHoleParts.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { StreamChevronsBox } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * Station header: name + metadata, a pill with no background.
 * Without lanes, it sits on the track row to the right of the light; with lanes, it moves to the platform row while
 * the light stays on its own track. The marker is identical in both places, so it is shared outside `WorkflowTimeline.tsx`.
 *
 * A non-clickable station header uses `span` rather than a disabled `button`: browsers do not dispatch clicks on disabled controls,
 * which would prevent the host card toggle from receiving the event. A span has no button semantics and clicks bubble normally.
 */
export function StationHead({
  caret,
  foldClass,
  name,
  onSelect,
  station,
  title,
}: {
  station: TimelineStation;
  name: string;
  /** Cursor that follows the typewriter in a draft; null otherwise. */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** Absent means the header is not a control; clicks bubble to the host (the whole end-of-turn summary toggle). */
  onSelect?: () => void;
}) {
  const pending = station.status === undefined || station.status === "pending";
  // Hole station (docs/dynamic-workflow/presentation.md, “Holes on the timeline”): use subtle
  // styling until its name arrives, then show “Waiting to be filled” in the metadata slot. A fill
  // without phases gets a pen marker after its name. Do not show the type in the UI.
  const hole = station.hole;
  const head = (
    <>
      <span
        className={cn(
          "truncate text-ui-caption font-medium",
          pending ? "text-foreground-subtle" : "text-foreground",
        )}
      >
        {name}
        {caret}
      </span>
      {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
      {hole?.state === "waiting" ? (
        <HoleWaitingMeta hole={hole} />
      ) : (
        <StationMeta station={station} />
      )}
    </>
  );
  return onSelect === undefined ? (
    <span
      className={cn(
        "wf-station flex h-6 min-w-0 shrink items-center gap-2 rounded-md text-left",
        foldClass,
      )}
      data-testid="workflow-timeline-station-head"
      title={title}
    >
      {head}
    </span>
  ) : (
    <button
      className={cn(
        "wf-station wf-station-open flex h-6 min-w-0 shrink cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        foldClass,
      )}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {head}
    </button>
  );
}

interface RowProps {
  stations: readonly TimelineStation[];
  /** Fill growth (`use-fill-growth.ts`): stations with an index greater than `after` receive `wf-slide` and move from −shift into place. */
  slide?: FillSlide;
  /** Full station names by index; in a draft, the typewriter reveals only the first few characters. */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * Track row (without lanes): station header (light + name + metadata) and track segment to the next station, one cell per station.
 * A station collapsed onto the ledge keeps only its track segment. Pill columns do not collapse (user revision: symmetric on both sides);
 * they move with scrolling and fade only at the actual viewport edges.
 */
export function WorkflowStationRow({
  draft,
  folded,
  fresh,
  fullNames,
  onSelectStation,
  pen,
  rails,
  slide,
  stations,
  tailStub,
  titleOf,
  top,
  width,
}: RowProps & {
  /** Track segment between adjacent stations, looked up by `railKey`. */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
  /** The final station is a tail hole: `open` draws a 40px dashed segment fading after it; `filled` only reserves space. */
  tailStub?: "open" | "filled";
  /** Station written by a fill newly joined to the run: the lamp lands and rail segments grow (`wf-land` / `wf-rail-grow`). */
  fresh?: ReadonlySet<string>;
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const stream = rail?.kind === "stream";
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        const landing = draft || (station.fill !== undefined && fresh?.has(station.fill) === true);
        const last = i === n - 1;
        return (
          <div
            className={cn(
              "flex h-6 min-w-0 items-center",
              station.ghost && "wf-ghost",
              slideClass(i, slide),
            )}
            data-fill={station.fill}
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-ghost={station.ghost ? "true" : undefined}
            data-station-hole={station.hole?.state}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{
              ...slideStyle(i, slide),
              width: !last
                ? STATION_PITCH
                : STATION_WIDTH + (tailStub === undefined ? 0 : TAIL_STUB),
            }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status, station.hole),
                "mx-3",
                foldClass,
                landing && "wf-land",
              )}
              data-lamp={
                station.hole !== undefined && station.hole.state !== "filled"
                  ? `hole-${station.hole.state}`
                  : (station.status ?? "pending")
              }
            />
            <StationHead
              caret={
                penHere ? (
                  // Cursor follows the typewriter: steady while writing and blinking when it catches up with the stream.
                  <span
                    aria-hidden
                    className={cn(
                      "ml-px inline-block h-3 w-px bg-foreground align-[-1px]",
                      pen.idle && "wf-caret",
                    )}
                    data-pen={pen.idle ? "idle" : "writing"}
                    data-testid="workflow-timeline-caret"
                  />
                ) : null
              }
              foldClass={foldClass}
              name={name}
              station={station}
              title={titleOf(station)}
              {...(onSelectStation === undefined
                ? {}
                : { onSelect: () => onSelectStation(station) })}
            />
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 flex-1 rounded-full border-t border-foreground-subtlest",
                  // Stream rail (presentation.md, “Stream rails”): leave a centered gap for the
                  // chevrons (`::before` draws the line and the border is transparent). It needs at
                  // least 42px so the three chevrons have a line segment on each side; never overlay transit light.
                  stream ? "wf-rail-stream min-w-[42px]" : "min-w-3",
                  landing && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // A segment touching an open hole is dashed because there is no code there yet (docs/dynamic-workflow/presentation.md).
                  rail?.dashed && "border-dashed",
                  // Draw the moving segment's base line as usual, then overlay a stationary light (`.wf-rail-march::after`) that brightens toward the light.
                  !stream && rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-dashed={rail?.dashed ? "true" : undefined}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-kind={rail?.kind}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              >
                {stream ? (
                  <StreamChevronsBox ink={rail.ink} style={{ left: "50%", top: -0.5 }} />
                ) : null}
              </span>
            ) : tailStub === "open" ? (
              // Tail hole: extend the rail 40px beyond it and fade out; the end of the script has not been written yet.
              <span
                aria-hidden
                className="wf-tail-stub h-0 shrink-0 border-t border-dashed border-foreground-subtlest"
                data-testid="workflow-timeline-tail-stub"
                style={{ marginLeft: 10, width: TAIL_STUB }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Platform row: with lanes, all station headers move to this row below the tracks while their lights stay on their own tracks.
 * Branch-track stations connect back to their names with dotted guides; main-line stations need none because their light is directly above the name.
 * Drafts never have lanes, so the typewriter is not needed here.
 */
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  slide,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className={cn(
            "absolute flex h-6 min-w-0 items-center",
            station.ghost && "wf-ghost",
            slideClass(i, slide),
          )}
          data-fill={station.fill}
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-hole={station.hole?.state}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: stationX(i, layout.inset) + CAPTION_X,
            top: layout.capY - PLATFORM_ROW / 2,
            width: STATION_WIDTH - CAPTION_X,
          }}
        >
          <StationHead
            caret={null}
            foldClass={cn("wf-foldable", folded.has(i) && "wf-folded")}
            name={fullNames[i]!}
            station={station}
            title={titleOf(station)}
            {...(onSelectStation === undefined ? {} : { onSelect: () => onSelectStation(station) })}
          />
        </div>
      ))}
    </>
  );
}
