// ============================================================
// Shared types for background-stop dispatch.
// ============================================================
// Extracted from background.ts for use by that module and the stop-branch modules dispatched by RuntimeTaskType
// (see background-stop-dynamic-workflow.ts). Kept in a separate file so branch modules need not import
// background.ts, avoiding circular type imports and keeping background.ts small.
//
// background.ts continues to re-export these names, so existing import paths in agent-runtime.ts /
// internal-turn-methods.ts remain unchanged.

import type { BackgroundTaskInfo, BackgroundTaskInfoStatus } from "../deps.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";
import type { TraceContext } from "../deps.js";

export type RuntimeBackgroundStopFailureReason =
  | "background_task_cancel_not_supported"
  | "background_task_not_found"
  | "background_task_not_running";

export type RuntimeBackgroundStopStatus = BackgroundTaskInfoStatus | RuntimeTaskSnapshot["status"];

export type RuntimeBackgroundStopResult =
  | {
      alreadyTerminal?: boolean;
      command?: string;
      ok: true;
      status: RuntimeBackgroundStopStatus;
      taskId: string;
      type: RuntimeTaskType;
    }
  | {
      reason: RuntimeBackgroundStopFailureReason;
      ok: false;
      status?: RuntimeBackgroundStopStatus;
      taskId: string;
      type?: RuntimeTaskType;
    };

/**
 * Calls from the GUI/background panel through `runtime.cancelBackgroundTask` use `"user"`, while the model's `TaskStop` uses `"model"`;
 * system paths such as runtime cleanup omit it. The dwf branch records it on the registry entry, allowing terminal notifications to tell the model
 * "the user made this decision; do not resume on your own."
 */
export type RuntimeBackgroundStopInitiator = "user" | "model";

export interface RuntimeBackgroundStopOptions {
  initiator?: RuntimeBackgroundStopInitiator;
  strict?: boolean;
  traceContext?: TraceContext;
}

export interface RuntimeBackgroundStopTarget {
  currentStatus: RuntimeBackgroundStopStatus | undefined;
  existing: BackgroundTaskInfo | undefined;
  registryTask: RuntimeTaskSnapshot | undefined;
  taskId: string;
  taskType: RuntimeTaskType | undefined;
}

/** Stop target with taskType already resolved; branch modules accept only this shape. */
export type TypedRuntimeBackgroundStopTarget = RuntimeBackgroundStopTarget & {
  taskType: RuntimeTaskType;
};
