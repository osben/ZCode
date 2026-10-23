import type { ModelTrajectoryV2PaneProps, ZCodeModelTrajectoryV2 } from "./contract.js";
import { buildLedgerRows } from "./index.js";

export const examplePaneProps: ModelTrajectoryV2PaneProps = {
  taskId: "task-1",
  title: "Example",
  workspacePath: "/workspace",
};

export function exampleLedger(trajectory: ZCodeModelTrajectoryV2) {
  return buildLedgerRows(trajectory, { showSidecars: false });
}
