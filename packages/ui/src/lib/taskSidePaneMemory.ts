import type { GitChangeSourceId } from "@zcode/shared";
import {
  normalizeWorkspaceSidePaneState,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

export interface TaskSidePaneMemoryState {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
  /** Conversation-level expand/collapse preference; tabs themselves are still reused per workspace. */
  sidePaneCollapsedByOwner: Record<string, boolean>;
  /** Records consumed automatic tool-call opens; retained when message rows unmount. */
  pluginUiAutoOpenKeys: ReadonlySet<string>;
  activeGitSourceId: GitChangeSourceId;
  browserUrls: Record<string, string>;
  /** @deprecated URL for the legacy single browser tab, retained to read historical in-memory state. */
  browserUrl: string | null;
}

const DEFAULT_TASK_SIDE_PANE_MEMORY_STATE: TaskSidePaneMemoryState = {
  sidePaneState: null,
  isSidePaneCollapsed: true,
  sidePaneCollapsedByOwner: {},
  pluginUiAutoOpenKeys: new Set(),
  activeGitSourceId: "unstaged",
  browserUrls: {},
  browserUrl: null,
};

export const TASK_SIDE_PANE_MEMORY_MAX_ENTRIES = 50;

const DRAFT_SIDE_PANE_OWNER_KEY = "__draft__";

const taskSidePaneMemory = new Map<string, TaskSidePaneMemoryState>();

function touchTaskSidePaneMemoryEntry(
  key: string,
  state: TaskSidePaneMemoryState,
): TaskSidePaneMemoryState {
  taskSidePaneMemory.delete(key);
  taskSidePaneMemory.set(key, state);
  return state;
}

function pruneTaskSidePaneMemory(): void {
  while (taskSidePaneMemory.size > TASK_SIDE_PANE_MEMORY_MAX_ENTRIES) {
    const oldestKey = taskSidePaneMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    taskSidePaneMemory.delete(oldestKey);
  }
}

export function buildTaskSidePaneMemoryKey({
  workspacePath,
  workspaceIdentity,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
}): string | null {
  // The side pane represents “the current workspace's right-side auxiliary workspace,”
  // not private task context. Adding taskId to the key previously meant that switching tasks in the same workspace created a fresh side-pane state,
  // making the browser / git / code viewer look as if it had been “cleared as part of switching tasks.”
  // Key only by workspace identity again so tasks in the same workspace share side-pane state.
  void taskId;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return workspaceKey.trim() ? workspaceKey : null;
}

export function readTaskSidePaneMemoryState(key: string | null): TaskSidePaneMemoryState {
  if (!key) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const state = taskSidePaneMemory.get(key);
  if (!state) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const normalizedState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...state,
    sidePaneState: normalizeWorkspaceSidePaneState(state.sidePaneState),
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...state.sidePaneCollapsedByOwner,
    },
  };
  return touchTaskSidePaneMemoryEntry(key, normalizedState);
}

export function saveTaskSidePaneMemoryState(
  key: string | null,
  patch: Partial<TaskSidePaneMemoryState>,
): void {
  if (!key) {
    return;
  }

  // Side-pane memory is a renderer module-level cache. If old keys are never evicted while switching among many workspaces,
  // they keep tabs, browser URLs, diff patches, and other state alive. Use a simple LRU cap
  // to retain recently visited workspace state and prevent unbounded Map growth in long-running sessions.
  const nextState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...taskSidePaneMemory.get(key),
    ...patch,
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...taskSidePaneMemory.get(key)?.sidePaneCollapsedByOwner,
      ...patch.sidePaneCollapsedByOwner,
    },
  };
  nextState.sidePaneState = normalizeWorkspaceSidePaneState(nextState.sidePaneState);
  touchTaskSidePaneMemoryEntry(key, nextState);
  pruneTaskSidePaneMemory();
}

export function getSidePaneCollapsedPreference(
  state: TaskSidePaneMemoryState,
  ownerTaskId: string | null | undefined,
): boolean | undefined {
  return state.sidePaneCollapsedByOwner[ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY];
}

export function saveTaskSidePaneCollapsedPreference(
  key: string | null,
  ownerTaskId: string | null | undefined,
  isSidePaneCollapsed: boolean,
): void {
  if (!key) return;

  const state = readTaskSidePaneMemoryState(key);
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  saveTaskSidePaneMemoryState(key, {
    isSidePaneCollapsed,
    sidePaneCollapsedByOwner: {
      ...state.sidePaneCollapsedByOwner,
      [ownerKey]: isSidePaneCollapsed,
    },
  });
}

export function clearTaskSidePaneMemoryStateForTest(): void {
  taskSidePaneMemory.clear();
}

export function claimPluginUiSidePaneAutoOpen(
  workspaceKey: string | null,
  requestKey: string,
): boolean {
  if (!workspaceKey) return false;
  const state = readTaskSidePaneMemoryState(workspaceKey);
  if (state.pluginUiAutoOpenKeys.has(requestKey)) return false;
  // Root cause: An inline useRef is lost after a session switch or virtual unmount, allowing a stale fullscreen result to overwrite the saved collapsed state.
  // Share the side-pane preference’s in-memory owner; synchronous consumption also ensures multiple anchors for one call trigger only once.
  saveTaskSidePaneMemoryState(workspaceKey, {
    pluginUiAutoOpenKeys: new Set([...state.pluginUiAutoOpenKeys, requestKey]),
  });
  return true;
}
