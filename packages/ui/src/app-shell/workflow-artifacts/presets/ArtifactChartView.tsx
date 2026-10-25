/**
 * **Implementation** of the `chart` preset renderer (recharts is in this module, and only here).
 *
 * Do not statically import it from index: during module initialization, recharts triggers decimal.js-light's LN10 validation,
 * which can block the entire renderer from starting in an Electron Linux container (see the fix documented in `AppUsagePanel.tsx`).
 * The public entry point is `ArtifactChart.tsx`, which uses `lazy()` to defer this module until after the first screen.
 *
 * Two forms:
 * - `compact`: **axis-free sparkline + latest value** in a run side-panel card;
 * - Full size: chart with axes + legend + reference lines + tooltip in the `workflow-artifact` tab.
 */

import { memo, useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import {
  applyArtifactItems,
  type ArtifactItem,
  type ChartModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  artifactSeriesColorVar,
  artifactSeriesDash,
  artifactSeriesSymbol,
  ARTIFACT_CHART_MAX_SERIES,
} from "@/app-shell/workflow-artifacts/presets/palette.js";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";

/** Above this point count, do not draw point markers; a line crowded with dots is harder to read than a line without them. */
const MAX_VISIBLE_DOTS = 60;
const FULL_MARGIN = { top: 8, right: 16, bottom: 0, left: 0 } as const;
const COMPACT_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 } as const;

/**
 * Reveal new points: React keys use each item's stable `sequence`, so only points **newly mounted in this frame** animate;
 * existing points keep the same DOM node and do not replay.
 * Under `motion-reduce`, the `animate-none` class directly disables the animation.
 */
function renderRevealDot(props: DotItemDotProps) {
  const { cx, cy, payload, stroke, index } = props;
  if (typeof cx !== "number" || typeof cy !== "number") {
    return null;
  }
  const sequence =
    payload && typeof payload === "object" && typeof payload.sequence === "number"
      ? payload.sequence
      : index;
  return (
    <circle
      className={REVEAL_ANIMATION_CLASS}
      cx={cx}
      cy={cy}
      fill={stroke}
      key={`reveal-${sequence}`}
      r={4}
    />
  );
}

function buildChartConfig(model: ChartModel): ChartConfig {
  return model.series.reduce<ChartConfig>((config, series) => {
    config[series.key] = {
      label: series.label,
      color: artifactSeriesColorVar(series.colorIndex),
    };
    return config;
  }, {});
}

function seriesMarks(model: ChartModel, showDots: boolean) {
  return model.series.map((series) => {
    const color = `var(--color-${series.key})`;
    if (model.type === "bar") {
      return <Bar dataKey={series.key} fill={color} key={series.key} isAnimationActive={false} />;
    }
    if (model.type === "scatter") {
      return (
        <Scatter
          dataKey={series.key}
          fill={color}
          isAnimationActive={false}
          key={series.key}
          // Point shape is a secondary encoding in the scatter plot (a second identity cue besides color), like line style in the line chart.
          shape={artifactSeriesSymbol(series.colorIndex)}
        />
      );
    }
    return (
      <Line
        connectNulls={false}
        dataKey={series.key}
        dot={showDots ? renderRevealDot : false}
        // Recharts' own entry animation redraws the **entire line** whenever data changes; on a live-growing chart,
        // the whole line would flash every time a point arrives. Disable it here so CSS on new points alone handles the reveal.
        isAnimationActive={false}
        key={series.key}
        stroke={color}
        strokeDasharray={artifactSeriesDash(series.colorIndex)}
        strokeWidth={2}
        type="monotone"
      />
    );
  });
}

/**
 * Actual chart body, memoized with a custom comparator: **rerender only when point count / domain / series composition changes**.
 *
 * This prevents the first-frame freeze fixed in the portfolio: recharts mirrors props into an internal store in an effect,
 * and if the parent creates a new data reference on every render, that mirror chain amplifies into hundreds or thousands of pointless updates.
 * Entries are append-only, so "point count + first/last sequence + domain" is enough to determine whether data actually changed.
 */
type PlotProps = { model: ChartModel; compact: boolean };

/**
 * Comparator for `memo` (`true` = skip rerender). Exported separately for direct testing—"when not to redraw"
 * is part of this chart's performance contract, and would be difficult to pin down if hidden as memo's second argument.
 */
export function chartPlotPropsEqual(previous: PlotProps, next: PlotProps): boolean {
  if (previous.compact !== next.compact) {
    return false;
  }
  const a = previous.model;
  const b = next.model;
  if (a.type !== b.type || a.scale !== b.scale || a.x.numeric !== b.x.numeric) {
    return false;
  }
  if (a.series.length !== b.series.length) {
    return false;
  }
  if (a.series.some((series, index) => series.label !== b.series[index]?.label)) {
    return false;
  }
  if (a.points.length !== b.points.length) {
    return false;
  }
  // First/last sequence also detects a whole batch being replaced (for example, reloaded during cold recovery) without changing point count.
  if (a.points[0]?.sequence !== b.points[0]?.sequence) {
    return false;
  }
  if (a.points.at(-1)?.sequence !== b.points.at(-1)?.sequence) {
    return false;
  }
  if (a.baseline?.value !== b.baseline?.value) {
    return false;
  }
  return (
    a.domain?.xMin === b.domain?.xMin &&
    a.domain?.xMax === b.domain?.xMax &&
    a.domain?.yMin === b.domain?.yMin &&
    a.domain?.yMax === b.domain?.yMax
  );
}

const ArtifactChartPlot = memo(function ArtifactChartPlot({ model, compact }: PlotProps) {
  const config = useMemo(() => buildChartConfig(model), [model]);
  const showDots = model.points.length <= MAX_VISIBLE_DOTS;
  // Only numeric x values use a numeric axis; bars are inherently categorical, so always use a category axis (band scale gives the correct bar width).
  const categoricalX = model.type === "bar" || !model.x.numeric;
  const logDomain: [number, number] | undefined =
    model.scale === "log" && model.domain ? [model.domain.yMin, model.domain.yMax] : undefined;

  if (compact) {
    return (
      <ChartContainer className="h-14 w-full" config={config}>
        <ComposedChart data={model.points} margin={COMPACT_MARGIN}>
          <XAxis
            dataKey={categoricalX ? "xLabel" : "x"}
            hide
            type={categoricalX ? "category" : "number"}
          />
          <YAxis hide {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})} />
          {seriesMarks(model, showDots && model.points.length <= 24)}
        </ComposedChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer className="h-56 w-full" config={config}>
      <ComposedChart data={model.points} margin={FULL_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={categoricalX ? "xLabel" : "x"}
          minTickGap={16}
          tickLine={false}
          tickMargin={8}
          type={categoricalX ? "category" : "number"}
          {...(categoricalX ? {} : { domain: ["dataMin", "dataMax"] as [string, string] })}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={4}
          width={44}
          {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})}
        />
        {model.baseline ? (
          <ReferenceLine
            label={{
              fill: "var(--color-foreground-subtle)",
              fontSize: 10,
              position: "insideTopRight",
              value: model.baseline.label,
            }}
            stroke="var(--color-foreground-subtlest)"
            strokeDasharray="4 4"
            y={model.baseline.value}
          />
        ) : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const point = payload?.[0]?.payload as { xLabel?: string } | undefined;
                return fieldHeading(point?.xLabel ?? "", model.x.unit);
              }}
            />
          }
          cursor={false}
        />
        {seriesMarks(model, showDots)}
      </ComposedChart>
    </ChartContainer>
  );
}, chartPlotPropsEqual);

/**
 * Legend. **Always present (≥1 series)**, and each series has a line style and latest value in addition to color—
 * identity is never conveyed by color alone (see palette.ts for why palette slots are not pairwise distinguishable for color-vision deficiencies).
 */
function ChartLegendRow({ model }: { model: ChartModel }) {
  const latest = model.points.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="list">
      {model.series.map((series) => {
        const value = latest?.[series.key];
        return (
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui-sm"
            data-testid="artifact-chart-legend-item"
            key={series.key}
            role="listitem"
          >
            <svg aria-hidden="true" className="shrink-0" height={8} width={16}>
              <line
                stroke={artifactSeriesColorVar(series.colorIndex)}
                strokeDasharray={artifactSeriesDash(series.colorIndex)}
                strokeWidth={2}
                x1={0}
                x2={16}
                y1={4}
                y2={4}
              />
            </svg>
            <span className="truncate text-foreground-subtle">{series.label}</span>
            {typeof value === "number" ? (
              // Label the latest value directly: the legend is more than a color swatch + name; it also reports this series' current reading.
              <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
                {series.unit ? `${value} ${series.unit}` : String(value)}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** Latest value to the right of the compact form—the sparkline has no axis, so this supplies its numeric value. */
function CompactLatestValue({ model }: { model: ChartModel }) {
  const series = model.series[0];
  const latest = model.points.at(-1);
  const value = series && latest ? latest[series.key] : undefined;
  if (typeof value !== "number") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-baseline gap-1" data-testid="artifact-chart-latest">
      <span
        className={cn(
          "font-mono text-ui-base font-medium text-foreground tabular-nums",
          REVEAL_ANIMATION_CLASS,
        )}
        key={`latest-${latest?.sequence ?? "none"}`}
      >
        {value}
      </span>
      {series?.unit ? (
        <span className="text-ui-xs text-foreground-subtle">{series.unit}</span>
      ) : null}
    </span>
  );
}

export function ArtifactChartView({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  const model = useMemo(() => {
    const built = applyArtifactItems("chart", spec, items);
    // There are only six color slots; do not draw extra series. Reusing colors cyclically would make two series look identical.
    return built.series.length > ARTIFACT_CHART_MAX_SERIES
      ? { ...built, series: built.series.slice(0, ARTIFACT_CHART_MAX_SERIES) }
      : built;
  }, [spec, items]);

  if (model.points.length === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-2", className)}
        data-testid="artifact-chart-compact"
      >
        <div className="min-w-0 flex-1">
          <ArtifactChartPlot compact model={model} />
        </div>
        <CompactLatestValue model={model} />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-chart">
      <PresetHeading className="mb-2" description={spec.description} title={spec.title} />
      <div className="mb-2">
        <ChartLegendRow model={model} />
      </div>
      <ArtifactChartPlot compact={false} model={model} />
      <div className="mt-1 text-center text-ui-xs text-foreground-subtlest">
        {fieldHeading(model.x.label, model.x.unit)}
      </div>
    </div>
  );
}

export default ArtifactChartView;
