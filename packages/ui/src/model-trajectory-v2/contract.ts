export type {
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2CacheBreakpoint,
  ZCodeTrajectoryV2ContextWindow,
  ZCodeTrajectoryV2Record,
  ZCodeTrajectoryV2RequestParams,
  ZCodeTrajectoryV2SystemBlock,
  ZCodeTrajectoryV2ToolDef,
  ZCodeTrajectoryV2ToolTiming,
  ZCodeTrajectoryV2Usage,
} from "@zcode/services";

/** Side-pane tab content for one task's v2 trajectory (specs/model-trajectory-v2.md). */
export interface ModelTrajectoryV2PaneProps {
  taskId: string;
  title?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  onClose?: () => void;
}
