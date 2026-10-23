import { cn } from "@/components/lib/utils.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { formatBytes, formatMs, payloadPreview } from "../domain/format.js";
import { fileNameOf, type EventCategory } from "../domain/eventCategories.js";
import type { LedgerRow } from "../domain/ledger.js";
import { tr, type TrajectoryIntl } from "./intl.js";

/** Badge and strip colors per category; text always accompanies color (spec rule 46). */
export const CATEGORY_STYLES: Record<
  EventCategory,
  { badge: string; fill: string; label: string }
> = {
  skill: {
    badge: "text-trajectory-skill bg-trajectory-skill/10",
    fill: "fill-trajectory-skill",
    label: "modelTrajectoryV2.category.skill",
  },
  memory: {
    badge: "text-trajectory-memory bg-trajectory-memory/10",
    fill: "fill-trajectory-memory",
    label: "modelTrajectoryV2.category.memory",
  },
  mcp: {
    badge: "text-trajectory-mcp bg-trajectory-mcp/10",
    fill: "fill-trajectory-mcp",
    label: "modelTrajectoryV2.category.mcp",
  },
};

export function CategoryBadge({
  category,
  intl,
}: {
  category: EventCategory;
  intl: TrajectoryIntl;
}) {
  const style = CATEGORY_STYLES[category];
  return (
    <span
      data-trajectory-v2-badge={category}
      className={cn("w-16 shrink-0 rounded-sm px-1 text-ui-xs font-medium uppercase", style.badge)}
    >
      {tr(intl, style.label)}
    </span>
  );
}

/** H3 row text for categorized tool rows and memory context rows. */
export function CategoryRowBody({ row, intl }: { row: LedgerRow; intl: TrajectoryIntl }) {
  if (row.kind === "context") {
    const files = row.files.map(fileNameOf).join(", ");
    return (
      <span className="truncate text-ui-sm text-foreground">
        {tr(intl, `modelTrajectoryV2.context.${row.source}`, { count: String(row.files.length) })}
        {files ? <span className="text-foreground-subtle"> ({files})</span> : null}
      </span>
    );
  }
  if (row.kind !== "tool" || !row.category) return null;
  const { skill, mcp, memory } = row.category;
  const result = row.result
    ? payloadPreview(row.result.output, 120) || tr(intl, "modelTrajectoryV2.tool.noOutput")
    : tr(intl, "modelTrajectoryV2.tool.pending");
  let text: string;
  if (skill) {
    text = tr(intl, "modelTrajectoryV2.skill.loaded", {
      name: skill.name,
      size: formatBytes(skill.loadedBytes),
    });
  } else if (mcp) {
    text = `${mcp.server} · ${mcp.tool} ${payloadPreview(row.input, 80)} → ${result}`;
  } else if (memory) {
    text = `${tr(intl, `modelTrajectoryV2.memory.${memory.op}`)} · ${memory.fileName} (${row.toolName})`;
  } else {
    text = row.toolName;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-ui-sm">
      <span
        className={cn(
          "min-w-0 truncate",
          row.result?.isError ? "text-destructive" : "text-foreground",
        )}
      >
        {text}
      </span>
      {row.timing?.execDurationMs !== undefined ? (
        <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
          {formatMs(row.timing.execDurationMs)}
        </span>
      ) : null}
    </span>
  );
}

const CHIP_ORDER: EventCategory[] = ["skill", "memory", "mcp"];

/** H1: one-at-a-time category filter with counts over the loaded window. */
export function TrajectoryCategoryChips({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const summary = model.categories;
  const counts: Record<EventCategory, number> = {
    skill: summary.skillCalls,
    memory: summary.memoryReads + summary.memoryWrites + summary.memorySidecars,
    mcp: summary.mcpCalls,
  };
  if (CHIP_ORDER.every((category) => counts[category] === 0)) return null;
  const detail: Record<EventCategory, string> = {
    skill: String(counts.skill),
    memory: tr(intl, "modelTrajectoryV2.chips.memoryDetail", {
      reads: String(summary.memoryReads),
      writes: String(summary.memoryWrites),
    }),
    mcp: tr(intl, "modelTrajectoryV2.chips.mcpDetail", {
      calls: String(summary.mcpCalls),
      servers: String(summary.mcpServers.length),
    }),
  };
  const active = model.categoryFilter;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5"
      data-trajectory-v2-chips=""
    >
      {CHIP_ORDER.filter((category) => counts[category] > 0).map((category) => (
        <button
          key={category}
          type="button"
          aria-pressed={active === category}
          data-trajectory-v2-chip={category}
          data-trajectory-v2-chip-count={counts[category]}
          onClick={() => model.setCategoryFilter(active === category ? null : category)}
          className={cn(
            "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-ui-xs",
            active === category
              ? "border-ring bg-surface-hover"
              : "border-border hover:bg-surface-hover",
          )}
        >
          <span
            className={cn("rounded-sm px-1 font-medium uppercase", CATEGORY_STYLES[category].badge)}
          >
            {tr(intl, CATEGORY_STYLES[category].label)}
          </span>
          <span className="text-foreground-subtle">{detail[category]}</span>
        </button>
      ))}
      {active ? (
        <button
          type="button"
          data-trajectory-v2-chip="all"
          onClick={() => model.setCategoryFilter(null)}
          className="rounded-md px-1.5 py-0.5 text-ui-xs text-foreground-subtle underline"
        >
          {tr(intl, "modelTrajectoryV2.chips.all")}
        </button>
      ) : null}
    </div>
  );
}

/** H4: skills loaded, memory reads and writes, MCP calls per server. */
export function TrajectoryCategorySummary({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const summary = model.categories;
  const items: { key: string; text: string }[] = [];
  if (summary.skills.length > 0) {
    items.push({
      key: "skills",
      text: tr(intl, "modelTrajectoryV2.categorySummary.skills", {
        names: summary.skills
          .map((skill) => (skill.calls > 1 ? `${skill.name} ×${skill.calls}` : skill.name))
          .join(", "),
      }),
    });
  }
  if (summary.memoryReads + summary.memoryWrites > 0) {
    items.push({
      key: "memory",
      text: tr(intl, "modelTrajectoryV2.categorySummary.memory", {
        reads: String(summary.memoryReads),
        writes: String(summary.memoryWrites),
      }),
    });
  }
  if (summary.mcpServers.length > 0) {
    items.push({
      key: "mcp",
      text: tr(intl, "modelTrajectoryV2.categorySummary.mcp", {
        servers: summary.mcpServers
          .map(
            (server) =>
              `${server.server} ×${server.calls}${server.execMs ? ` (${formatMs(server.execMs)})` : ""}`,
          )
          .join(", "),
      }),
    });
  }
  if (items.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap gap-x-3 text-ui-xs text-foreground-subtle"
      data-trajectory-v2-category-summary=""
    >
      {items.map((item) => (
        <span
          key={item.key}
          data-trajectory-v2-category-summary-item={item.key}
          className="min-w-0 truncate"
        >
          {item.text}
        </span>
      ))}
    </div>
  );
}
