import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { tr, type TrajectoryIntl } from "./intl.js";
import { TrajectoryLedgerRow } from "./TrajectoryLedgerRows.js";

const ESTIMATED_ROW_HEIGHT = 28;

/** Block C: virtualized event ledger with keyboard selection (ArrowUp / ArrowDown). */
export function TrajectoryLedger({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = model.visibleRows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const selectedIndex = rows.findIndex((row) => row.key === model.selectedKey);
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        model.step(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Escape" && model.range) {
        model.setRange(null);
      }
    },
    [model],
  );

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-ui-sm text-foreground-subtle">
        {tr(intl, "modelTrajectoryV2.ledger.emptyRange")}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={tr(intl, "modelTrajectoryV2.ledger.label")}
      aria-activedescendant={model.selectedKey ? `trajectory-v2-row-${selectedIndex}` : undefined}
      data-trajectory-v2-ledger=""
      data-trajectory-v2-row-count={rows.length}
      onKeyDown={onKeyDown}
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TrajectoryLedgerRow
                id={`trajectory-v2-row-${item.index}`}
                row={row}
                model={model}
                intl={intl}
                selected={row.key === model.selectedKey}
                onSelect={model.select}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
