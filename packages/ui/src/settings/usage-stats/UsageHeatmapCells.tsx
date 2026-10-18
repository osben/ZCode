import type { CSSProperties } from "react";
import type { AppUsageHeatmapCell } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";

const HEATMAP_LEVEL_STYLES = [
  "var(--color-usage-heatmap-0)",
  "var(--color-usage-heatmap-1)",
  "var(--color-usage-heatmap-2)",
  "var(--color-usage-heatmap-3)",
  "var(--color-usage-heatmap-4)",
];

export type TokenActivityMode = "daily" | "weekly" | "cumulative";

export interface HeatmapDisplayCell {
  key: string;
  /** Local calendar date of a real daily cell; set only where drilling into the day is meaningful. */
  date?: string;
  tooltipTitle?: string;
  level: AppUsageHeatmapCell["level"];
  hasUsage: boolean;
  columnHover: boolean;
}

export interface HeatmapDisplayColumn {
  key: string;
  monthDate: string;
  tooltipTitle: string | null;
  cells: HeatmapDisplayCell[];
}

function getHeatmapCellStyle(level: number): CSSProperties {
  return {
    backgroundColor: HEATMAP_LEVEL_STYLES[level] ?? HEATMAP_LEVEL_STYLES[0],
  };
}

export function HeatmapColumn({
  column,
  mode,
  onSelectDate,
}: {
  column: HeatmapDisplayColumn;
  mode: TokenActivityMode;
  onSelectDate?: (date: string) => void;
}) {
  const node = (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1",
        mode !== "daily" && "group/usage-heatmap-column",
      )}
    >
      {column.cells.map((cell) => (
        <HeatmapCell key={cell.key} cell={cell} onSelectDate={onSelectDate} />
      ))}
    </div>
  );

  if (!column.tooltipTitle) {
    return node;
  }

  return <ControlHintTooltip title={column.tooltipTitle}>{node}</ControlHintTooltip>;
}

function HeatmapCell({
  cell,
  onSelectDate,
}: {
  cell: HeatmapDisplayCell;
  onSelectDate?: (date: string) => void;
}) {
  const selectable = Boolean(onSelectDate && cell.date && cell.hasUsage);
  const select = () => {
    if (onSelectDate && cell.date) {
      onSelectDate(cell.date);
    }
  };
  const node = (
    <div
      className={cn(
        "aspect-square w-full min-w-0 rounded-[4px] border transition-transform hover:scale-110 hover:border-border-hover",
        cell.hasUsage ? "border-border" : "border-transparent",
        cell.columnHover && "group-hover/usage-heatmap-column:border-border-hover",
        selectable && "cursor-pointer",
      )}
      style={getHeatmapCellStyle(cell.level)}
      {...(selectable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": cell.date,
            onClick: select,
            onKeyDown: (event: { key: string; preventDefault: () => void }) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select();
              }
            },
          }
        : {})}
    />
  );

  if (cell.tooltipTitle) {
    return <ControlHintTooltip title={cell.tooltipTitle}>{node}</ControlHintTooltip>;
  }

  return node;
}
