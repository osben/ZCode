import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodeModelTrajectoryV2 } from "../contract.js";
import { buildLedgerRows, filterRowsByRange, type LedgerRow } from "../domain/ledger.js";
import { contextSeries, summarizeTrajectory, toolTimeByName } from "../domain/metrics.js";
import { domainOf, type TimeDomain } from "../domain/timeScale.js";
import { reconcileRange, reconcileSelection, stepSelection } from "../domain/viewState.js";

const EMPTY: ZCodeModelTrajectoryV2 = {
  taskId: "",
  available: false,
  truncated: false,
  sourceFiles: [],
  records: [],
  toolDefs: {},
  toolCatalogs: {},
  systemBlocks: {},
  systemPrompts: {},
  contextWindows: [],
  toolTiming: { source: "session-db", entries: [] },
  budget: { toolDefBytes: 0, systemBytes: 0, omitted: false },
};

/**
 * Derived view model and pane-local view state: rows, metrics, selection and range. Selection and range survive new
 * data when they still apply (specs/model-trajectory-v2.md, "View state").
 */
export function useTrajectoryV2Model(data: ZCodeModelTrajectoryV2 | null, showSidecars: boolean) {
  const trajectory = data ?? EMPTY;
  const rows = useMemo(
    () => buildLedgerRows(trajectory, { showSidecars }),
    [trajectory, showSidecars],
  );
  const summary = useMemo(() => summarizeTrajectory(trajectory), [trajectory]);
  const toolTimes = useMemo(() => toolTimeByName(trajectory), [trajectory]);
  const context = useMemo(() => contextSeries(trajectory), [trajectory]);
  const extent = useMemo(
    () =>
      domainOf(
        rows.filter((row) => row.kind !== "turn").map((row) => ({ start: row.t0, end: row.t1 })),
      ),
    [rows],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [range, setRange] = useState<TimeDomain | null>(null);

  useEffect(() => {
    setSelectedKey((key) => reconcileSelection(key, rows));
    setRange((current) => reconcileRange(current, extent));
  }, [rows, extent]);

  const visibleRows = useMemo(() => filterRowsByRange(rows, range), [rows, range]);
  const selectedRow = useMemo<LedgerRow | null>(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  );
  const step = useCallback(
    (direction: 1 | -1) => setSelectedKey((key) => stepSelection(visibleRows, key, direction)),
    [visibleRows],
  );

  return {
    trajectory,
    rows,
    visibleRows,
    summary,
    toolTimes,
    context,
    extent,
    selectedKey,
    selectedRow,
    select: setSelectedKey,
    step,
    range,
    setRange,
  };
}

export type TrajectoryV2Model = ReturnType<typeof useTrajectoryV2Model>;
