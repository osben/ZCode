import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { formatMs } from "../domain/format.js";
import { tr, type TrajectoryIntl } from "./intl.js";

const MAX_ROWS = 8;

/** Block G: execution time per tool name plus a model bar; unavailable timing is stated, never shown as zero. */
export function TrajectoryToolTimeChart({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const unavailable = model.trajectory.toolTiming.source === "unavailable";
  const rows = [
    {
      name: tr(intl, "modelTrajectoryV2.toolTime.model"),
      totalMs: model.summary.modelSumMs,
      calls: model.summary.mainCalls + model.summary.otherCalls,
      model: true,
    },
    ...model.toolTimes.slice(0, MAX_ROWS).map((row) => ({ ...row, model: false })),
  ];
  const max = Math.max(1, ...rows.map((row) => row.totalMs));

  return (
    <div
      className="min-w-0"
      data-trajectory-v2-tool-time={unavailable ? "unavailable" : "session-db"}
    >
      <div className="pb-1 text-ui-xs font-medium text-foreground-subtle">
        {tr(intl, "modelTrajectoryV2.toolTime.title")}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={`${row.model}:${row.name}`}
            className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)_max-content] items-center gap-2 text-ui-xs"
          >
            <span className="truncate font-mono text-foreground">{row.name}</span>
            <span className="h-1.5 rounded-full bg-surface">
              <span
                className={
                  row.model
                    ? "block h-full rounded-full bg-trajectory-assistant"
                    : "block h-full rounded-full bg-trajectory-tool-call"
                }
                style={{ width: `${Math.max(1, (row.totalMs / max) * 100)}%` }}
              />
            </span>
            <span className="text-foreground-subtle">
              {tr(intl, "modelTrajectoryV2.toolTime.value", {
                time: formatMs(row.totalMs),
                calls: String(row.calls),
              })}
            </span>
          </li>
        ))}
      </ul>
      {unavailable ? (
        <p className="pt-1 text-ui-xs text-foreground-subtle">
          {tr(intl, "modelTrajectoryV2.timing.unavailable")}
        </p>
      ) : null}
    </div>
  );
}
