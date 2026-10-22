import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { useElementWidth } from "../app/useTrajectoryV2Prefs.js";
import { formatClock, formatMs } from "../domain/format.js";
import {
  normalizeRange,
  packLane,
  panDomain,
  ticks,
  timeToX,
  xToTime,
  zoomDomain,
  type LaneSpan,
  type TimeDomain,
} from "../domain/timeScale.js";
import { tr, type TrajectoryIntl } from "./intl.js";

const LANE_LABEL_WIDTH = 48;
const SUB_ROW_HEIGHT = 8;
const SUB_ROW_GAP = 2;
const DRAG_THRESHOLD_PX = 3;

interface Lanes {
  model: ReturnType<typeof packLane>;
  tools: ReturnType<typeof packLane>;
}

function buildLanes(model: TrajectoryV2Model): Lanes {
  const modelSpans: LaneSpan[] = [];
  const toolSpans: LaneSpan[] = [];
  for (const row of model.rows) {
    if (row.kind === "request") {
      const record = model.trajectory.records[row.recordIndex];
      const ttft = record?.timing?.timeToFirstContentMs;
      modelSpans.push({
        key: row.key,
        start: row.t0,
        end: row.t1,
        ...(ttft !== undefined ? { firstTokenAt: Math.min(row.t1, row.t0 + ttft) } : {}),
        isError: Boolean(record?.error),
      });
    } else if (row.kind === "tool" && row.t1 > row.t0) {
      toolSpans.push({ key: row.key, start: row.t0, end: row.t1, isError: row.result?.isError });
    }
  }
  return { model: packLane(modelSpans), tools: packLane(toolSpans) };
}

function laneHeight(rows: number): number {
  return rows * (SUB_ROW_HEIGHT + SUB_ROW_GAP) + SUB_ROW_GAP;
}

/** Block B: wall-clock overview with Model and Tools lanes; drag selects a range, Ctrl/Cmd+wheel zooms, Shift+wheel pans. */
export function TrajectoryOverviewStrip({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const width = Math.max(0, useElementWidth(host) - LANE_LABEL_WIDTH);
  const lanes = useMemo(() => buildLanes(model), [model]);
  const bounds = model.extent;
  const [view, setView] = useState<TimeDomain | null>(null);
  const [drag, setDrag] = useState<{ startX: number; currentX: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => setView(null), [model.trajectory.taskId]);
  const domain = view ?? bounds;

  const pointerX = useCallback((event: { clientX: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? Math.min(Math.max(0, event.clientX - rect.left), rect.width) : 0;
  }, []);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = pointerX(event);
    setDrag({ startX: x, currentX: x });
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (drag) setDrag({ ...drag, currentX: pointerX(event) });
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag || !domain || !bounds) return;
    const endX = pointerX(event);
    setDrag(null);
    if (Math.abs(endX - drag.startX) < DRAG_THRESHOLD_PX) {
      const target = (event.target as Element).closest("[data-span-key]");
      const key = target?.getAttribute("data-span-key");
      if (key) model.select(key);
      return;
    }
    model.setRange(
      normalizeRange(xToTime(drag.startX, domain, width), xToTime(endX, domain, width), bounds),
    );
  };
  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    if (!domain || !bounds || (!event.ctrlKey && !event.metaKey && !event.shiftKey)) return;
    event.preventDefault();
    if (event.shiftKey) {
      const delta =
        ((event.deltaY || event.deltaX) / Math.max(1, width)) * (domain.to - domain.from);
      setView(panDomain(domain, delta, bounds));
    } else {
      const anchor = xToTime(pointerX(event), domain, width);
      setView(zoomDomain(domain, anchor, event.deltaY > 0 ? 1.25 : 0.8, bounds));
    }
  };

  if (!domain || !bounds) return null;
  const modelHeight = laneHeight(lanes.model.rows);
  const toolsHeight = laneHeight(lanes.tools.rows);
  const height = modelHeight + toolsHeight + 16;
  const rangeX = model.range
    ? { from: timeToX(model.range.from, domain, width), to: timeToX(model.range.to, domain, width) }
    : null;
  const dragX = drag
    ? { from: Math.min(drag.startX, drag.currentX), to: Math.max(drag.startX, drag.currentX) }
    : null;
  const tickTimes = width > 0 ? ticks(domain, Math.max(2, Math.floor(width / 90))) : [];

  const renderLane = (lane: ReturnType<typeof packLane>, top: number, kind: "model" | "tool") =>
    lane.spans.map((span) => {
      const x0 = timeToX(span.start, domain, width);
      const x1 = Math.max(x0 + 2, timeToX(span.end, domain, width));
      const y = top + SUB_ROW_GAP + span.subRow * (SUB_ROW_HEIGHT + SUB_ROW_GAP);
      const selected = span.key === model.selectedKey;
      const color = kind === "model" ? "fill-trajectory-assistant" : "fill-trajectory-tool-call";
      const ttftX =
        span.firstTokenAt !== undefined ? timeToX(span.firstTokenAt, domain, width) : undefined;
      return (
        <g key={span.key} data-span-key={span.key} className="cursor-pointer">
          <title>{`${formatClock(span.start)} · ${formatMs(span.end - span.start)}`}</title>
          {ttftX !== undefined && ttftX > x0 ? (
            <>
              <rect
                x={x0}
                y={y}
                width={ttftX - x0}
                height={SUB_ROW_HEIGHT}
                rx={2}
                className={cn(color, "opacity-35")}
              />
              <rect
                x={ttftX}
                y={y}
                width={Math.max(1, x1 - ttftX)}
                height={SUB_ROW_HEIGHT}
                rx={2}
                className={color}
              />
            </>
          ) : (
            <rect
              x={x0}
              y={y}
              width={x1 - x0}
              height={SUB_ROW_HEIGHT}
              rx={2}
              className={cn(color, span.isError && "fill-destructive")}
            />
          )}
          {selected ? (
            <rect
              x={x0 - 1}
              y={y - 1}
              width={x1 - x0 + 2}
              height={SUB_ROW_HEIGHT + 2}
              rx={2}
              className="fill-none stroke-foreground"
            />
          ) : null}
        </g>
      );
    });

  return (
    <div className="shrink-0 border-b border-border px-3 py-1.5" data-trajectory-v2-strip="">
      <div className="flex items-center justify-between gap-2 pb-1 text-ui-xs text-foreground-subtle">
        <span>{tr(intl, "modelTrajectoryV2.strip.hint")}</span>
        {model.range ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-trajectory-v2-clear-range=""
            onClick={() => model.setRange(null)}
          >
            <XIcon className="size-3" />
            {tr(intl, "modelTrajectoryV2.strip.clearRange")}
          </Button>
        ) : null}
      </div>
      <div ref={setHost} className="flex w-full min-w-0">
        <div
          className="shrink-0 text-ui-xs text-foreground-subtle"
          style={{ width: LANE_LABEL_WIDTH }}
        >
          <div style={{ height: modelHeight }} className="flex items-center">
            {tr(intl, "modelTrajectoryV2.strip.model")}
          </div>
          <div style={{ height: toolsHeight }} className="flex items-center">
            {tr(intl, "modelTrajectoryV2.strip.tools")}
          </div>
        </div>
        <svg
          ref={svgRef}
          role="img"
          aria-label={tr(intl, "modelTrajectoryV2.strip.label")}
          width={width}
          height={height}
          className="touch-none select-none"
          data-trajectory-v2-range={
            model.range ? `${model.range.from}-${model.range.to}` : undefined
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onWheel={onWheel}
        >
          <rect x={0} y={0} width={width} height={modelHeight} className="fill-surface/40" />
          <rect
            x={0}
            y={modelHeight}
            width={width}
            height={toolsHeight}
            className="fill-surface/20"
          />
          {renderLane(lanes.model, 0, "model")}
          {renderLane(lanes.tools, modelHeight, "tool")}
          {tickTimes.map((time) => {
            const x = timeToX(time, domain, width);
            return (
              <g key={time}>
                <line
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={modelHeight + toolsHeight}
                  className="stroke-border"
                  strokeDasharray="2 3"
                />
                <text x={x + 2} y={height - 3} className="fill-foreground-subtle text-ui-xs">
                  {formatClock(time).slice(0, 8)}
                </text>
              </g>
            );
          })}
          {rangeX ? (
            <rect
              x={rangeX.from}
              y={0}
              width={Math.max(1, rangeX.to - rangeX.from)}
              height={modelHeight + toolsHeight}
              className="fill-accent/25 stroke-ring"
            />
          ) : null}
          {dragX ? (
            <rect
              x={dragX.from}
              y={0}
              width={dragX.to - dragX.from}
              height={modelHeight + toolsHeight}
              className="fill-accent/20"
            />
          ) : null}
        </svg>
      </div>
    </div>
  );
}
