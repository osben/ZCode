import type { ModelTrajectoryV2Ports } from "./contract.js";
import { projectModelTrajectoryV2 } from "./index.js";

export async function exampleModelTrajectoryV2() {
  const ports: ModelTrajectoryV2Ports = {
    modelIo: { read: async () => ({ records: [], sourceFiles: [], truncated: false }) },
    toolTiming: { read: async () => ({ source: "session-db", entries: [] }) },
    contextWindow: async () => 200_000,
  };
  return projectModelTrajectoryV2("task-1", 200, ports);
}
