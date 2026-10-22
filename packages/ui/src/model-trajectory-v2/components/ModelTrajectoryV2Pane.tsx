import { useCallback, useState } from "react";
import { ChartNoAxesGanttIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { TID_MODEL_TRAJECTORY_V2_REFRESH } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsMobileCompactViewport } from "@/lib/mobileTextInput.js";
import type { ModelTrajectoryV2PaneProps } from "../contract.js";
import { useModelTrajectoryV2 } from "../app/useModelTrajectoryV2.js";
import { useElementWidth, useTrajectoryV2Prefs } from "../app/useTrajectoryV2Prefs.js";
import { useTrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { TrajectoryContextChart } from "./TrajectoryContextChart.js";
import { TrajectoryInspector } from "./TrajectoryInspector.js";
import { TrajectoryLedger } from "./TrajectoryLedger.js";
import { TrajectoryOverviewStrip } from "./TrajectoryOverviewStrip.js";
import { TrajectorySummaryLine } from "./TrajectorySummaryLine.js";
import { TrajectoryToolTimeChart } from "./TrajectoryToolTimeChart.js";
import { TrajectoryV2Layout } from "./TrajectoryV2Layout.js";

/** Below this container width the inspector becomes a drill-in view. */
const WIDE_MIN_WIDTH = 720;

export function ModelTrajectoryV2Pane({
  taskId,
  title,
  workspacePath,
  workspaceIdentity,
  onClose,
}: ModelTrajectoryV2PaneProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values);
  const load = useModelTrajectoryV2(workspacePath, taskId, workspaceIdentity);
  const [prefs, updatePrefs] = useTrajectoryV2Prefs();
  const model = useTrajectoryV2Model(load.data, prefs.showSidecars);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(container);
  const mobile = useIsMobileCompactViewport();
  const layout = mobile ? "sheet" : width > 0 && width < WIDE_MIN_WIDTH ? "drill-in" : "split";
  const hasRecords = model.trajectory.records.length > 0;
  const refreshing = load.status === "loading" || load.status === "refreshing";
  const toggleSidecars = useCallback(
    () => updatePrefs({ showSidecars: !prefs.showSidecars }),
    [prefs.showSidecars, updatePrefs],
  );
  const toggleCharts = useCallback(
    () => updatePrefs({ chartsCollapsed: !prefs.chartsCollapsed }),
    [prefs.chartsCollapsed, updatePrefs],
  );
  const sidecarLabel = t(
    prefs.showSidecars ? "modelTrajectoryV2.hideSidecars" : "modelTrajectoryV2.showSidecars",
  );
  const chartsLabel = t(
    prefs.chartsCollapsed ? "modelTrajectoryV2.showCharts" : "modelTrajectoryV2.hideCharts",
  );

  return (
    <div
      ref={setContainer}
      data-trajectory-v2-state={load.status}
      data-trajectory-v2-layout={layout}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex shrink-0 flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1" title={taskId}>
            <span className="block truncate text-ui-base font-medium text-foreground">
              {title?.trim() || t("modelTrajectoryV2.title")}
            </span>
          </div>
          {hasRecords ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-trajectory-v2-toggle-sidecars={prefs.showSidecars ? "on" : "off"}
              onClick={toggleSidecars}
              aria-label={sidecarLabel}
              title={sidecarLabel}
            >
              {prefs.showSidecars ? (
                <EyeIcon className="size-4" />
              ) : (
                <EyeOffIcon className="size-4" />
              )}
            </Button>
          ) : null}
          {hasRecords ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={!prefs.chartsCollapsed}
              data-trajectory-v2-toggle-charts=""
              onClick={toggleCharts}
              aria-label={chartsLabel}
              title={chartsLabel}
            >
              <ChartNoAxesGanttIcon className="size-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid={TID_MODEL_TRAJECTORY_V2_REFRESH}
            onClick={load.refresh}
            aria-label={t("modelTrajectoryV2.refresh")}
            title={t("modelTrajectoryV2.refresh")}
          >
            <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t("modelTrajectoryV2.close")}
              title={t("modelTrajectoryV2.close")}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        {hasRecords ? <TrajectorySummaryLine model={model} intl={intl} /> : null}
        {load.status === "error" && load.data ? (
          <p className="text-ui-xs text-destructive" data-trajectory-v2-error="">
            {t("modelTrajectoryV2.refreshFailed", { message: load.error ?? "" })}
          </p>
        ) : null}
      </header>
      <div className="h-px shrink-0 bg-border" />

      {!hasRecords ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
          {load.status === "error"
            ? t("modelTrajectoryV2.error", { message: load.error ?? "" })
            : load.status === "loading"
              ? t("modelTrajectoryV2.loading")
              : t("modelTrajectoryV2.empty")}
        </div>
      ) : (
        <>
          <TrajectoryOverviewStrip model={model} intl={intl} />
          {!prefs.chartsCollapsed ? (
            <div
              data-trajectory-v2-charts=""
              className={cn(
                "grid shrink-0 gap-2 border-b border-border px-3 py-2",
                layout === "split" ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              <TrajectoryContextChart model={model} intl={intl} />
              <TrajectoryToolTimeChart model={model} intl={intl} />
            </div>
          ) : null}
          <TrajectoryV2Layout
            layout={layout}
            model={model}
            intl={intl}
            ledger={<TrajectoryLedger model={model} intl={intl} />}
            inspector={<TrajectoryInspector model={model} intl={intl} />}
          />
        </>
      )}
    </div>
  );
}
