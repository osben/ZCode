import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeArchivedTaskDeletionResult } from "#src/session/zcodeTaskService.js";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
} from "../session/zcodeTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "rename"; title: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = ZCodeTaskListItem & {
  sourceServerId?: string;
  serverDisplayName?: string;
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  executionWorktree?: WindowHostControllerTaskRow["executionWorktree"];
  executionWorktreeMissing?: WindowHostControllerTaskRow["executionWorktreeMissing"];
  incognito?: WindowHostControllerTaskRow["incognito"];
  worktreePreparation?: WindowHostControllerTaskRow["worktreePreparation"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<ZCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/** 仅实时发送；列表快照与重同步不能重放一次完成提醒。 */
export interface WindowHostTaskUnreadSignal {
  address: WindowHostTaskAddress;
  updatedAt: number;
  status: "completed" | "error";
}

/**
 * The window-level Controller service carries only list projections and cross-source routing.
 * conversation/file/git/terminal are still provided by the scoped facade for each attachment.
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  /** 直接读取所属 owner 的轻量 meta；未读 CAS 不得使用可能降级为旧快照的列表投影。 */
  getTaskMeta(params: { address: WindowHostTaskAddress }): Promise<ZCodeTaskMeta | null>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ZCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
  onDynamicTaskUnreadSignal(): Event<WindowHostTaskUnreadSignal>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
