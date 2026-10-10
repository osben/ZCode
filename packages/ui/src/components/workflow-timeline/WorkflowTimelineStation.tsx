import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

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
      <StationMeta station={station} />
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
  fullNames,
  onSelectStation,
  pen,
  rails,
  stations,
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
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        return (
          <div
            className="flex h-6 min-w-0 items-center"
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{ width: i < n - 1 ? STATION_PITCH : STATION_WIDTH }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status),
                "mx-3",
                foldClass,
                draft && "wf-land",
              )}
              data-lamp={station.status ?? "pending"}
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
            {i < n - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 min-w-3 flex-1 rounded-full border-t border-foreground-subtlest",
                  draft && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // Draw the moving segment's base line as usual, then overlay a stationary light (`.wf-rail-march::after`) that brightens toward the light.
                  rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
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
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className="absolute flex h-6 min-w-0 items-center"
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
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
