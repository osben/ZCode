// Replay export barrel.
//
// The downstream browser replay page assembles the run detail page from **static data**: the board (WorkflowRunGraphSection), read-only
// SessionPane, collapsible section headers, and the Providers and data-layer seams they need. These components were originally
// used only by the App inside this package and not exported from index; export them together here without changing component behavior.
//
// Rule: re-export only; define nothing here.
//
// The Results / event log /
// Script sections have been removed from the product, so their three components and the corresponding exports are removed too. The pure
// formatter `workflowRunEventLines` and its i18n keys are **retained**: they are not part of the removed UI,
// but define how journal events are displayed, and browser replay still uses them with static data.
export { SessionPane, type SessionPaneProps } from "./v4/SessionPane.js";
export {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "./v4/V4ConversationContext.js";
export { SessionDataLayer, type SessionLease } from "./v4/sessionDataLayer.js";
export type { ConversationTransport, ConversationAttachmentReadParams } from "./v4/transport.js";
export { WorkflowRunPhaseList } from "./app-shell/WorkflowRunPhaseList.js";
export { WorkflowRunSectionToggle } from "./app-shell/WorkflowRunSectionToggle.js";
export {
  workflowRunEventLines,
  workflowRunResultView,
  type WorkflowActorInstance,
  type WorkflowRunEventItem,
  type WorkflowRunEventLine,
} from "./app-shell/workflowRunPanel.js";
export { WorkflowTimeline } from "./components/workflow-timeline/WorkflowTimeline.js";
export { buildWorkflowTimeline } from "./components/workflow-timeline/timeline-model.js";
export type { WorkflowCausalityGraphData } from "./components/workflow-graph/types.js";
export { workflowRunOverlay } from "./components/workflow-graph/run-status.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { DiffsWorkerPoolProvider } from "./root/DiffsWorkerPoolProvider.js";
export { ZCodeIntlProvider, useZCodeIntl } from "./i18n/IntlProvider.js";
export { Button } from "./components/ui/button.js";
export { cn } from "./components/lib/utils.js";
