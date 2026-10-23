import { memo } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { formatBytes, formatMs, payloadPreview, textPreview } from "../domain/format.js";
import type { LedgerRow } from "../domain/ledger.js";
import {
  describeParam,
  diffRequests,
  previousSameSource,
  requestFacts,
  type RequestChange,
} from "../domain/requestDiff.js";
import { rowCategory } from "../domain/categorySummary.js";
import { tr, type TrajectoryIntl } from "./intl.js";
import { CategoryBadge, CategoryRowBody } from "./TrajectoryCategories.js";

const KIND_STYLES: Record<string, { label: string; className: string }> = {
  user: { label: "modelTrajectoryV2.kind.user", className: "text-trajectory-user/80" },
  assistant: {
    label: "modelTrajectoryV2.kind.assistant",
    className: "text-trajectory-assistant/80",
  },
  tool: { label: "modelTrajectoryV2.kind.tool", className: "text-trajectory-tool-call/80" },
};

const previousIndexCache = new WeakMap<object, (number | undefined)[]>();

function previousIndexes(model: TrajectoryV2Model) {
  const records = model.trajectory.records;
  let cached = previousIndexCache.get(records);
  if (!cached) {
    cached = previousSameSource(records);
    previousIndexCache.set(records, cached);
  }
  return cached;
}

function changeLabel(change: RequestChange, intl: TrajectoryIntl): string {
  switch (change.kind) {
    case "model":
      return `${change.from ?? "—"} → ${change.to ?? "—"}`;
    case "param":
      return `${change.key} ${change.from ?? "—"} → ${change.to ?? "—"}`;
    case "tools":
      return tr(intl, "modelTrajectoryV2.change.tools", {
        added: String(change.added.length),
        removed: String(change.removed.length),
      });
    case "system":
      return tr(intl, "modelTrajectoryV2.change.system");
  }
}

function RequestRow({
  row,
  model,
  intl,
}: {
  row: Extract<LedgerRow, { kind: "request" }>;
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const record = model.trajectory.records[row.recordIndex];
  if (!record) return null;
  const facts = requestFacts(record, model.trajectory);
  const previousIndex = previousIndexes(model)[row.recordIndex];
  const previous =
    previousIndex === undefined ? undefined : model.trajectory.records[previousIndex];
  const changes = diffRequests(previous, record, model.trajectory);
  const params = record.request.params;
  const chips = [
    facts.model,
    describeParam(params, "maxOutputTokens") && `max ${describeParam(params, "maxOutputTokens")}`,
    describeParam(params, "thinking") && `thinking ${describeParam(params, "thinking")}`,
    describeParam(params, "effort") && `effort ${describeParam(params, "effort")}`,
    facts.toolCount !== undefined &&
      tr(intl, "modelTrajectoryV2.request.tools", {
        count: String(facts.toolCount),
        size: formatBytes(facts.toolBytes),
      }),
  ].filter((chip): chip is string => Boolean(chip));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-foreground-subtle">
      <span className="font-medium text-foreground">
        {tr(intl, `modelTrajectoryV2.source.${row.source}`)} #{row.recordIndex + 1}
      </span>
      {chips.map((chip) => (
        <span key={chip} className="font-mono">
          {chip}
        </span>
      ))}
      <span>{formatMs(record.durationMs)}</span>
      {changes.map((change, index) => (
        <span
          key={index}
          data-trajectory-v2-change={change.kind}
          className="rounded-sm bg-surface px-1 font-mono text-foreground"
        >
          {changeLabel(change, intl)}
        </span>
      ))}
    </div>
  );
}

function rowBody(row: LedgerRow, model: TrajectoryV2Model, intl: TrajectoryIntl) {
  switch (row.kind) {
    case "turn":
      return (
        <span className="text-ui-xs font-medium text-foreground">
          {tr(intl, "modelTrajectoryV2.turn")}{" "}
          <span className="font-mono">{row.turnId.slice(0, 13)}</span>
        </span>
      );
    case "marker":
      return (
        <span className="text-ui-xs text-foreground-subtle italic">
          {tr(intl, `modelTrajectoryV2.marker.${row.marker}`, {
            writes: String(row.memoryWrites ?? 0),
          })}
        </span>
      );
    case "context":
      return <CategoryRowBody row={row} intl={intl} />;
    case "request":
      return <RequestRow row={row} model={model} intl={intl} />;
    case "user":
      return <span className="truncate text-ui-sm text-foreground">{textPreview(row.text)}</span>;
    case "assistant":
      return (
        <span
          className={cn("truncate text-ui-sm", row.error ? "text-destructive" : "text-foreground")}
        >
          {row.error ??
            (textPreview(row.text) ||
              (row.toolCallCount > 0
                ? tr(intl, "modelTrajectoryV2.assistant.toolCallsOnly")
                : row.reasoning
                  ? tr(intl, "modelTrajectoryV2.assistant.reasoningOnly")
                  : "—"))}
        </span>
      );
    case "tool":
      if (row.category) return <CategoryRowBody row={row} intl={intl} />;
      return (
        <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-ui-sm">
          <span className="shrink-0 text-foreground">{row.toolName}</span>
          <span className="min-w-0 truncate text-foreground-subtle">
            {payloadPreview(row.input, 120)}
          </span>
          <span className="shrink-0 text-foreground-subtle">→</span>
          <span
            className={cn(
              "min-w-0 truncate",
              row.result?.isError ? "text-destructive" : "text-foreground",
            )}
          >
            {row.result
              ? payloadPreview(row.result.output, 160) ||
                tr(intl, "modelTrajectoryV2.tool.noOutput")
              : tr(intl, "modelTrajectoryV2.tool.pending")}
          </span>
          {row.timing?.execDurationMs !== undefined ? (
            <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
              {formatMs(row.timing.execDurationMs)}
            </span>
          ) : null}
        </span>
      );
  }
}

export const TrajectoryLedgerRow = memo(function TrajectoryLedgerRow({
  id,
  row,
  model,
  intl,
  selected,
  onSelect,
}: {
  id: string;
  row: LedgerRow;
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const category = rowCategory(row);
  const style = category ? undefined : KIND_STYLES[row.kind];
  const selectable = row.kind !== "turn";
  return (
    <div
      id={id}
      role={selectable ? "option" : "presentation"}
      aria-selected={selectable ? selected : undefined}
      data-trajectory-v2-row-kind={row.kind}
      data-trajectory-v2-row-key={row.key}
      data-trajectory-v2-category={category}
      data-trajectory-v2-selected={selected ? "true" : undefined}
      onClick={selectable ? () => onSelect(row.key) : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1",
        row.kind === "turn" && "bg-surface/70 pt-2",
        row.kind === "request" && "bg-surface/30",
        selectable && "cursor-pointer hover:bg-surface-hover",
        selected && "bg-accent",
      )}
    >
      {category && row.kind !== "marker" ? <CategoryBadge category={category} intl={intl} /> : null}
      {style ? (
        <span className={cn("w-16 shrink-0 text-ui-xs font-medium uppercase", style.className)}>
          {tr(intl, style.label)}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center">{rowBody(row, model, intl)}</div>
    </div>
  );
});
