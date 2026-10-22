import { readModelIORawWindow } from "#src/zcode-agent/modelTrajectory.js";
import type { ModelIoWindowPort } from "../contract.js";

/** The v1 bounded model-io reader: tail ≤ 32 MiB, ordered, writer deltas expanded, latest `limit` kept. */
export function createModelIoWindowPort(): ModelIoWindowPort {
  return { read: (taskId, limit) => readModelIORawWindow(taskId, limit) };
}
