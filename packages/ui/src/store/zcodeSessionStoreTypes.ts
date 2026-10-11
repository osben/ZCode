/* oxlint-disable eslint(max-lines) -- Keep ZCode Agent store types and default state exports together to avoid duplicating shared structures across slices. */
/**
 * ZCode Session Store type definitions, interfaces, constants, and default-value factories.
 *
 * Split out of zcodeSessionStore.ts for use by the store itself and submodules such as selectors and navigation.
 */
import {
  buildNativeSupplierKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeApiRetryStatus,
  type ModelSelectionGhostReason,
  type ModelSelectionResolution,
  type ZCodeWorkspaceInitStatus,
  type ZCodeTaskRuntimeStatus,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeContextCacheUsage,
  type ZCodeConfigOption,
  type ZCodeSlashCommand,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeSessionActiveTurnKind,
  type ZCodeContextUsageBreakdownItem,
  type InputId,
  type SessionCreateSource,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type {
  AutomationsNavigationTab,
  TaskNavigationHistory,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

// ────────────────────────────────────────────
// Interfaces
// ────────────────────────────────────────────

export interface WorkspaceInitState {
  status: ZCodeWorkspaceInitStatus;
  error: string | null;
  attempts: number;
}

export type GroupedDraftTaskPlacement = { type: "top" } | { type: "group"; groupId: string };

export interface GroupedDraftTaskState {
  draftId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  placement: GroupedDraftTaskPlacement;
  createdAt: number;
}

export interface TaskRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
  /** ZCode Agent process provider bound to this task's current runtime, used for the workspace-level busy lock during process recreation. */
  provider?: ZCodeProvider;
  /** Current model context-window capacity; model status events update only this field and do not overwrite the actual usage.used. */
  contextWindow: number | null;
  usage: TaskUsageState | null;
  apiRetry: ZCodeApiRetryStatus | null;
  /** Background-task controls explicitly reported by the Agent; runtime Host state that is not persisted to disk. */
  backgroundTaskControls: ZCodeBackgroundTaskControlItem[];
  /** Type of the current session's active turn; distinguishes normal generation from compact maintenance. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  activeInputId?: InputId;
  activeInputOwnerClientId?: string;
}

export interface DraftRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
}

export interface TaskUsageState {
  /** Number of tokens currently used in the context window. */
  used: number;
  /** Total token capacity of the current context window. */
  size: number;
  /** Cumulative cost reported by the Agent. */
  cost?: { amount: number; currency: string } | null;
  /** Current main-turn cache-hit information returned by the Agent/app protocol. */
  cache?: ZCodeContextCacheUsage;
  /** Context character count estimated by the Agent by source; used only to display proportions in the context-usage dialog. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export interface ElicitationFormDraft {
  questionIndex: number;
  drafts: Record<string, ElicitationAnswerDraft>;
}

/**
 * Store cleanup: TaskUiState is reduced to the human-intervention state that still needs remote
 * broadcast replay: pending permission/question dialog queues, renderer-local question drafts, and
 * error banners. Writers for old ChatView presentation state such as plan/goal/token debug were
 * removed with the old protocol path; reads now come from the v4 conversation projection.
 */
export interface TaskUiState {
  permissionRequest: ZCodePermissionRequest | null;
  pendingPermissionRequests: ZCodePermissionRequest[];
  elicitationRequest: ZCodeElicitationRequest | null;
  pendingElicitationRequests: ZCodeElicitationRequest[];
  elicitationFormDraftsByRequestId: Record<string, ElicitationFormDraft>;
  error: ZCodeUiError | null;
}

export type ModelSwitchStage =
  | "idle"
  | "settingModel"
  | "fallbackConfigOption"
  | "applyingCustomProvider"
  | "restartingRuntime"
  | "syncingSession"
  | "persistingWorkspace";

export type ConfigOptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ComposerMentionPrefill {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

export interface ComposerTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export interface TimelineBottomRequest {
  requestId: number;
  taskId: string;
}

export interface WorkspaceZCodeUIState {
  /** Task currently active in the workspace. */
  activeTaskId: string | null;
  /**
   * Workspace initialization state for the ZCode Agent.
   *
   * After migrating to a single ZCode Agent, keeping provider buckets would preserve multiple stale
   * states that the real runtime no longer updates. When switching task/draft/remote identity, the
   * UI could read ready/failed state from an old provider. Keep one source of truth per workspace;
   * the provider parameter remains only as a compatibility input for older callers.
   */
  workspaceInit: WorkspaceInitState;
  /** Temporary runtime state for a draft before it has a taskId; existing task state is derived from taskRuntimeByTaskId. */
  draftRuntime: DraftRuntimeState;
  /** Agent draft session for an unsent draft; it is excluded from the task list and promoted to a real task on first send. */
  draftSessionId: string | null;
  /**
   * Draft runtime capability invalidation version; increment when plugins, Skills, or other
   * capabilities change. Legacy drafts are closed through draftSessionId; protocol-v4 drafts use
   * this version to rebuild the prewarmed session inside the pane.
   */
  draftRuntimeInvalidationVersion: number;
  composerTextInsertVersion: number;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  timelineBottomRequestVersion: number;
  timelineBottomRequest: TimelineBottomRequest | null;
  /** Draft errors must survive page navigation so the message is not unmounted with local state when the user leaves and returns. */
  draftError: ZCodeUiError | null;
  /** Concurrency-guard requestId for model switching; only the latest request may be committed to the store. */
  modelSwitchRequestId: string | null;
  /** Whether a model switch is in progress (used to disable sending and show toolbar loading). */
  modelSwitchPending: boolean;
  /** Model-switch phase (used to select a more specific loading message). */
  modelSwitchStage: ModelSwitchStage;
  /** Runtime state per task, so the task list and status bar can read the real task state. */
  taskRuntimeByTaskId: Record<string, TaskRuntimeState>;
  /** Temporary UI state per task, preventing plan panels and permission dialogs from being lost when switching tasks. */
  taskUiByTaskId: Record<string, TaskUiState>;
  taskConfigOptionsByTaskId: Record<string, ZCodeConfigOption[]>;
  taskConfigOptionsStatusByTaskId: Record<string, ConfigOptionsStatus>;
  /** Compatibility cache for task unread state; task meta.unreadAt is the source of truth. */
  taskUnreadByTaskId: Record<string, boolean>;
  /** Optimistic metadata for the task list, preventing the left list from lagging before a new task is persisted. */
  optimisticTaskListByTaskId: Record<string, ZCodeTaskMeta>;
  /** UI-only draft anchor created by clicking New task in grouped mode; it is not part of the real task index. */
  groupedDraftTask: GroupedDraftTaskState | null;
  /** Entry point from which the user started the current draft; prewarming does not change its origin. */
  draftCreateSource: SessionCreateSource;
  /** After the first send creates a real task but before its grouped SQLite order is saved, the task inherits the draft anchor's local position. */
  promotedGroupedDraftTaskByTaskId: Record<string, GroupedDraftTaskState>;
  /** ZCode Agent provider selected for the current workspace. */
  selectedProvider: ZCodeProvider;
  /** Selected model-provider key (native/custom/ghost). */
  selectedSupplierKey: string;
  /** Whether the current provider is in ghost state. */
  isGhostSupplier: boolean;
  /** Source of the current ghost state. */
  supplierMismatchReason: ModelSelectionGhostReason | null;
  /** ZCode Agent configOptions (model, mode, reasoning level, and so on). */
  configOptions: ZCodeConfigOption[] | null;
  /** configOptions loading state. */
  configOptionsStatus: ConfigOptionsStatus;
  /** Available slash commands. */
  slashCommands: ZCodeSlashCommand[];
  /** Task-list version; incremented on task creation/deletion to refresh TaskList. */
  taskListVersion: number;
  /** Cache the fetched task list to prevent flicker when components remount. */
  taskListCache: ZCodeTaskMeta[] | null;
  /** Incremented when a new draft is created, prompting the input to focus after switching to draft state. */
  draftFocusVersion: number;
}

export interface ZCodeSessionStoreState {
  /** Maintain chat-related UI state per workspace. */
  workspaces: Record<string, WorkspaceZCodeUIState>;
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) => WorkspaceZCodeUIState;

  setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => void;
  promoteGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    draft: GroupedDraftTaskState,
    workspaceIdentity?: string,
  ) => void;
  clearPromotedGroupedDraftTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  setDraftSessionId: (
    workspacePath: string,
    sessionId: string | null,
    workspaceIdentity?: string,
  ) => void;
  invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing",
  ) => number;
  clearComposerTextInsertRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestTimelineBottom: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => number;
  clearTimelineBottomRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  startDraft: (
    workspacePath: string,
    provider?: ZCodeProvider,
    workspaceIdentity?: string,
    options?: {
      groupedDraftPlacement?: GroupedDraftTaskPlacement;
      createSource?: SessionCreateSource;
    },
  ) => void;
  clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => void;
  bindRuntimeProvider: (
    workspacePath: string,
    provider: ZCodeProvider,
    workspaceIdentity?: string,
  ) => void;
  setModelSelectionResolution: (
    workspacePath: string,
    resolution: Pick<
      ModelSelectionResolution,
      "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
    >,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitState: (
    workspacePath: string,
    status: ZCodeWorkspaceInitStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitAttempts: (
    workspacePath: string,
    attempts: number,
    workspaceIdentity?: string,
  ) => void;
  setTaskState: (
    workspacePath: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskRuntimeState: (
    workspacePath: string,
    taskId: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
    provider?: ZCodeProvider,
  ) => void;
  setTaskUsage: (
    workspacePath: string,
    taskId: string,
    usage: TaskUsageState | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskContextWindow: (
    workspacePath: string,
    taskId: string,
    contextWindow: number | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskApiRetryStatus: (
    workspacePath: string,
    taskId: string,
    apiRetry: ZCodeApiRetryStatus | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodePermissionRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodeElicitationRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    draft: ElicitationFormDraft,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskError: (
    workspacePath: string,
    taskId: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  setDraftError: (
    workspacePath: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  startModelSwitch: (
    workspacePath: string,
    requestId: string,
    stage?: ModelSwitchStage,
    workspaceIdentity?: string,
    options?: { pending?: boolean },
  ) => void;
  updateModelSwitchStage: (
    workspacePath: string,
    requestId: string,
    stage: ModelSwitchStage,
    workspaceIdentity?: string,
  ) => void;
  finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => void;
  setTaskConfigOptions: (
    workspacePath: string,
    taskId: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
    status?: ConfigOptionsStatus,
  ) => void;
  initializeBackgroundTaskRuntime: (
    workspacePath: string,
    params: {
      task: ZCodeTaskMeta;
      provider: ZCodeProvider;
      activeInputId: InputId;
      workspaceIdentity?: string;
    },
  ) => void;
  upsertOptimisticTaskListItem: (
    workspacePath: string,
    task: ZCodeTaskMeta,
    workspaceIdentity?: string,
  ) => void;
  removeOptimisticTaskListItem: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /** Clear selected and optimistic state after task deletion so the right pane does not keep showing the deleted task. */
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

  setConfigOptions: (
    workspacePath: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
  ) => void;
  setConfigOptionsStatus: (
    workspacePath: string,
    status: "idle" | "loading" | "ready" | "error",
    workspaceIdentity?: string,
  ) => void;
  setSlashCommands: (
    workspacePath: string,
    commands: ZCodeSlashCommand[],
    workspaceIdentity?: string,
  ) => void;
  setCurrentModeId: (
    workspacePath: string,
    modeId: string | null,
    workspaceIdentity?: string,
  ) => void;
  /** Called when the task list changes (task creation/deletion) to make zcodeTaskMetaMerge fetch the list again. */
  bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Update the cached fetched task list. */
  setTaskListCache: (
    workspacePath: string,
    tasks: ZCodeTaskMeta[],
    workspaceIdentity?: string,
  ) => void;
  /** Update a task's unread indicator, controlling the blue dot in the left pane. */
  setTaskUnreadIndicator: (
    workspacePath: string,
    taskId: string,
    hasUnread: boolean,
    workspaceIdentity?: string,
  ) => void;

  /** Workspace navigation history (global across workspaces, including tasks and Automations). */
  taskNavHistory: TaskNavigationHistory;
  /** Record navigation to the Automations main view or a detail view. */
  taskNavPushAutomations: (
    workspacePath: string,
    workspaceIdentity?: string,
    automationId?: string,
    automationTab?: AutomationsNavigationTab,
  ) => void;
  /** Record navigation to the plugin marketplace main view. */
  taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => void;
  /** Go back to the target entry; return null when at the beginning. */
  taskNavGoBack: () => WorkspaceNavEntry | null;
  /** Go forward to the target entry; return null when at the end. */
  taskNavGoForward: () => WorkspaceNavEntry | null;
  /** Remove the corresponding task entry from navigation history when a task is deleted. */
  removeTaskFromNavHistory: (taskId: string) => void;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

export const DEFAULT_WORKSPACE_INIT_STATE: WorkspaceInitState = {
  status: "idle",
  error: null,
  attempts: 0,
};

export const FALLBACK_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const DEFAULT_TASK_UI_STATE: TaskUiState = {
  permissionRequest: null,
  pendingPermissionRequests: [],
  elicitationRequest: null,
  pendingElicitationRequests: [],
  elicitationFormDraftsByRequestId: {},
  error: null,
};

export const DEFAULT_TASK_RUNTIME_STATE: TaskRuntimeState = {
  status: "notReady",
  error: null,
  provider: undefined,
  contextWindow: null,
  usage: null,
  apiRetry: null,
  backgroundTaskControls: [],
  activeTurnKind: undefined,
  activeInputId: undefined,
  activeInputOwnerClientId: undefined,
};

// ────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────

export function createDefaultWorkspaceState(
  selectedProvider: ZCodeProvider,
): WorkspaceZCodeUIState {
  return {
    activeTaskId: null,
    workspaceInit: { ...DEFAULT_WORKSPACE_INIT_STATE },
    draftRuntime: { status: "idle", error: null },
    draftSessionId: null,
    draftRuntimeInvalidationVersion: 0,
    composerTextInsertVersion: 0,
    composerTextInsertRequest: null,
    timelineBottomRequestVersion: 0,
    timelineBottomRequest: null,
    draftError: null,
    modelSwitchRequestId: null,
    modelSwitchPending: false,
    modelSwitchStage: "idle",
    taskRuntimeByTaskId: {},
    taskUiByTaskId: {},
    taskConfigOptionsByTaskId: {},
    taskConfigOptionsStatusByTaskId: {},
    taskUnreadByTaskId: {},
    optimisticTaskListByTaskId: {},
    groupedDraftTask: null,
    draftCreateSource: "session",
    promotedGroupedDraftTaskByTaskId: {},
    selectedProvider,
    selectedSupplierKey: buildNativeSupplierKey(selectedProvider),
    isGhostSupplier: false,
    supplierMismatchReason: null,
    configOptions: null,
    configOptionsStatus: "idle",
    slashCommands: [],
    taskListVersion: 0,
    taskListCache: null,
    draftFocusVersion: 0,
  };
}

const DEFAULT_WORKSPACE_STATE = createDefaultWorkspaceState(FALLBACK_PROVIDER);

export function getDefaultWorkspaceState(): WorkspaceZCodeUIState {
  // After migrating to a single ZCode Agent, the default provider must be glm.
  // Return a stable reference here so repeated selector reads before writing the workspace bucket do not produce different snapshots.
  return DEFAULT_WORKSPACE_STATE;
}
