// Native handler registry (add one spread per command group).
// Group filenames correspond to command groups: session-flow / queue / session-mgmt /
// goal-compact / model-config / interaction-background / fork-edit-retry。
import { forkEditRetryHandlers } from "./fork-edit-retry.js";
import { fileRewindHandlers } from "./file-rewind.js";
import { goalCompactHandlers } from "./goal-compact.js";
import { interactionBackgroundHandlers } from "./interaction-background.js";
import { modelConfigHandlers } from "./model-config.js";
import { queueHandlers } from "./queue.js";
import { sessionFlowHandlers } from "./session-flow.js";
import { sessionMgmtHandlers } from "./session-mgmt.js";
import { selectionSideSessionHandlers } from "./selection-side-session.js";
import { assistantFeedbackHandlers } from "./assistant-feedback.js";
import { rowPinHandlers } from "./row-pin.js";
import { highspeedMetricsHandlers } from "./highspeed-metrics.js";

export const NATIVE_HANDLERS = {
  ...sessionFlowHandlers,
  ...queueHandlers,
  ...sessionMgmtHandlers,
  ...selectionSideSessionHandlers,
  ...goalCompactHandlers,
  ...modelConfigHandlers,
  ...interactionBackgroundHandlers,
  ...forkEditRetryHandlers,
  ...fileRewindHandlers,
  ...assistantFeedbackHandlers,
  ...rowPinHandlers,
  ...highspeedMetricsHandlers,
} as const;

export type NativeCommandType = keyof typeof NATIVE_HANDLERS;
