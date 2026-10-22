import { useState } from "react";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { useElementWidth } from "../app/useTrajectoryV2Prefs.js";
import { formatRatio, formatTokens } from "../domain/format.js";
import { tr, type TrajectoryIntl } from "./intl.js";

const HEIGHT = 84;
const PAD_TOP = 6;
const PAD_BOTTOM = 14;

/**
 * Block F: context fill per main call. With every point's window known the axis is percent (dashed 100% line when in range);
 * otherwise it is tokens and percent is hidden. Compaction and context rewrites mark their point.
 */
export function TrajectoryContextChart({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(host);
  const points = model.context;
  const percentMode = points.length > 0 && points.every((point) => point.ratio !== undefined);
  const values = points.map((point) => (percentMode ? (point.ratio ?? 0) : point.inputTokens));
  // Scale to the data with headroom; a fixed 100% axis flattens typical single-digit fills into the baseline.
  const maxValue = percentMode ? Math.max(0.05, ...values) * 1.2 : Math.max(1, ...values) * 1.1;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const x = (index: number) =>
    points.length <= 1 ? width / 2 : (index / (points.length - 1)) * (width - 8) + 4;
  const y = (value: number) => PAD_TOP + plotHeight - (value / maxValue) * plotHeight;
  const path = points
    .map((_, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(values[index] ?? 0)}`)
    .join(" ");

  return (
    <div
      ref={setHost}
      className="min-w-0"
      data-trajectory-v2-context-chart={percentMode ? "percent" : "tokens"}
    >
      <div className="pb-1 text-ui-xs font-medium text-foreground-subtle">
        {tr(
          intl,
          percentMode
            ? "modelTrajectoryV2.context.titlePercent"
            : "modelTrajectoryV2.context.titleTokens",
        )}
      </div>
      {points.length === 0 ? (
        <p className="text-ui-xs text-foreground-subtle">
          {tr(intl, "modelTrajectoryV2.context.empty")}
        </p>
      ) : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={tr(intl, "modelTrajectoryV2.context.label")}
        >
          {percentMode && maxValue >= 1 ? (
            <line
              x1={0}
              x2={width}
              y1={y(1)}
              y2={y(1)}
              className="stroke-border"
              strokeDasharray="3 3"
            />
          ) : null}
          <path d={path} className="fill-none stroke-trajectory-user" strokeWidth={1.5} />
          {points.map((point, index) => {
            const key = model.rows.find(
              (row) => row.kind === "request" && row.recordIndex === point.recordIndex,
            )?.key;
            return (
              <g
                key={point.recordIndex}
                className="cursor-pointer"
                onClick={() => key && model.select(key)}
              >
                <title>
                  {`#${point.recordIndex + 1} · ${formatTokens(point.inputTokens)}${point.ratio !== undefined ? ` · ${formatRatio(point.ratio)}` : ""}${point.marker ? ` · ${tr(intl, `modelTrajectoryV2.marker.${point.marker}`)}` : ""}`}
                </title>
                {point.marker ? (
                  <line
                    x1={x(index)}
                    x2={x(index)}
                    y1={PAD_TOP}
                    y2={PAD_TOP + plotHeight}
                    className="stroke-trajectory-tool-call"
                    strokeDasharray={point.marker === "context-reset" ? "2 2" : undefined}
                    data-trajectory-v2-context-marker={point.marker}
                  />
                ) : null}
                <circle
                  cx={x(index)}
                  cy={y(values[index] ?? 0)}
                  r={point.recordIndex === selectedIndex(model) ? 3.5 : 2.5}
                  className="fill-trajectory-user"
                />
              </g>
            );
          })}
          <text x={0} y={HEIGHT - 2} className="fill-foreground-subtle text-ui-xs">
            {percentMode ? formatRatio(maxValue) : formatTokens(maxValue)}
          </text>
        </svg>
      )}
    </div>
  );
}

function selectedIndex(model: TrajectoryV2Model): number | undefined {
  const row = model.selectedRow;
  return row && "recordIndex" in row ? row.recordIndex : undefined;
}
