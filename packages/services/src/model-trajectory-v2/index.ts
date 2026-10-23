import { createModelIoWindowPort } from "./adapters/modelIoWindow.js";
import { createSqliteToolTimingPort } from "./adapters/toolTimingSqlite.js";
import { projectModelTrajectoryV2 } from "./app/projectTrajectoryV2.js";
import type { ContextWindowPort, ZCodeModelTrajectoryV2 } from "./contract.js";

export type * from "./contract.js";
export { projectModelTrajectoryV2 } from "./app/projectTrajectoryV2.js";
export { createSqliteToolTimingPort } from "./adapters/toolTimingSqlite.js";

const DEFAULT_LIMIT = 200;

/** Read a task's v2 trajectory from the local model-io files and CLI session database. */
export function readModelTrajectoryV2(
  taskId: string,
  options: { limit?: number; resolveContextWindow?: ContextWindowPort } = {},
): Promise<ZCodeModelTrajectoryV2> {
  return projectModelTrajectoryV2(taskId, options.limit ?? DEFAULT_LIMIT, {
    modelIo: createModelIoWindowPort(),
    toolTiming: createSqliteToolTimingPort(),
    contextWindow: options.resolveContextWindow,
  });
}
