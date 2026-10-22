import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { formatMs, formatRatio, formatTokens } from "../domain/format.js";
import { tr, type TrajectoryIntl } from "./intl.js";

/** Block A: one line of totals (specs/model-trajectory-v2.md, "Metrics"). */
export function TrajectorySummaryLine({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const { summary, trajectory } = model;
  const models = [
    ...new Set(trajectory.records.map((record) => record.model.modelId).filter(Boolean)),
  ];
  const items: { key: string; text: string; title?: string }[] = [
    {
      key: "calls",
      text: tr(intl, "modelTrajectoryV2.summary.calls", {
        main: String(summary.mainCalls),
        other: String(summary.otherCalls),
      }),
    },
    {
      key: "tokens",
      text: tr(intl, "modelTrajectoryV2.summary.tokens", {
        input: formatTokens(summary.inputTokens),
        output: formatTokens(summary.outputTokens),
      }),
    },
  ];
  if (summary.cacheHitRatio !== undefined) {
    items.push({
      key: "cache",
      text: tr(intl, "modelTrajectoryV2.summary.cache", {
        value: formatRatio(summary.cacheHitRatio),
      }),
    });
  }
  if (summary.peakContextRatio !== undefined) {
    items.push({
      key: "context",
      text: tr(intl, "modelTrajectoryV2.summary.context", {
        value: formatRatio(summary.peakContextRatio),
      }),
    });
  }
  items.push({
    key: "model-time",
    text: tr(intl, "modelTrajectoryV2.summary.modelTime", { value: formatMs(summary.modelBusyMs) }),
    title: tr(intl, "modelTrajectoryV2.summary.sumTitle", { value: formatMs(summary.modelSumMs) }),
  });
  items.push(
    summary.toolBusyMs === undefined
      ? { key: "tool-time", text: tr(intl, "modelTrajectoryV2.summary.toolTimeUnavailable") }
      : {
          key: "tool-time",
          text: tr(intl, "modelTrajectoryV2.summary.toolTime", {
            value: formatMs(summary.toolBusyMs),
          }),
          title: tr(intl, "modelTrajectoryV2.summary.sumTitle", {
            value: formatMs(summary.toolSumMs),
          }),
        },
  );

  return (
    <div
      data-trajectory-v2-summary=""
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-foreground-subtle"
    >
      {items.map((item, index) => (
        <span key={item.key} data-trajectory-v2-summary-item={item.key} title={item.title}>
          {index > 0 ? "· " : ""}
          {item.text}
        </span>
      ))}
      {models.length > 0 ? (
        <span className="min-w-0 truncate font-mono">· {models.join(", ")}</span>
      ) : null}
    </div>
  );
}
