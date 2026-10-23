import type { ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { BottomSheet, BottomSheetContent, BottomSheetTitle } from "@/components/mobile-ui/index.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import { tr, type TrajectoryIntl } from "./intl.js";

export type TrajectoryV2LayoutMode = "split" | "drill-in" | "sheet";

/**
 * Ledger and inspector arrangement: side by side in a resizable split, a drill-in view with Back on narrow panes, and a
 * bottom sheet on the mobile compact viewport (specs/model-trajectory-v2.md, "Layout").
 */
export function TrajectoryV2Layout({
  layout,
  model,
  intl,
  ledger,
  inspector,
}: {
  layout: TrajectoryV2LayoutMode;
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
  ledger: ReactNode;
  inspector: ReactNode;
}) {
  if (layout === "split") {
    return (
      <ResizablePanelGroup layoutId="model-trajectory-v2-inspector" className="min-h-0 flex-1">
        <ResizablePanel id="ledger" minSize="240px" className="min-h-0 min-w-0">
          {ledger}
        </ResizablePanel>
        <ResizableHandle
          aria-label={tr(intl, "modelTrajectoryV2.resizeInspector")}
          className={WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME}
        />
        <ResizablePanel
          id="inspector"
          defaultSize="40%"
          minSize="240px"
          className="min-h-0 min-w-0 border-l border-border"
        >
          {inspector}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  if (layout === "drill-in" && model.selectedRow) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-trajectory-v2-drill-in="">
        <div className="flex shrink-0 items-center border-b border-border px-2 py-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => model.select(null)}>
            <ArrowLeftIcon className="size-4" />
            {tr(intl, "modelTrajectoryV2.back")}
          </Button>
        </div>
        <div className="min-h-0 flex-1">{inspector}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ledger}
      {layout === "sheet" ? (
        <BottomSheet
          open={Boolean(model.selectedRow)}
          onOpenChange={(open) => !open && model.select(null)}
        >
          <BottomSheetContent aria-describedby={undefined}>
            <BottomSheetTitle className="sr-only">
              {tr(intl, "modelTrajectoryV2.inspector")}
            </BottomSheetTitle>
            <div className="min-h-0 flex-1 overflow-hidden">{inspector}</div>
          </BottomSheetContent>
        </BottomSheet>
      ) : null}
    </div>
  );
}
