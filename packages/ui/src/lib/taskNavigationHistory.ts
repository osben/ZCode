/**
 * Workspace navigation history — a browser-style back/forward stack.
 *
 * Pure data structures + immutable update functions, with no React dependency.
 * zcodeSessionStore owns the instance and drives UI state.
 */

interface WorkspaceNavEntryBase {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskNavEntry extends WorkspaceNavEntryBase {
  kind: "task";
  taskId: string;
}

// "workflow" is the top-level “Workflows” tab on the Automations page;
// scheduled / idle remain pills within the “Automations” tab.
export type AutomationsNavigationTab = "scheduled" | "idle" | "workflow";

export type OpenAutomationsMain = (
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
) => void;

export interface AutomationsNavEntry extends WorkspaceNavEntryBase {
  kind: "automations";
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export interface PluginStoreNavEntry extends WorkspaceNavEntryBase {
  kind: "plugin-store";
}

export type WorkspaceNavEntry = TaskNavEntry | AutomationsNavEntry | PluginStoreNavEntry;

export interface TaskNavigationHistory {
  entries: WorkspaceNavEntry[];
  /** Current pointer to an index in entries; -1 means empty. */
  cursor: number;
}

const MAX_HISTORY = 50;

export function createTaskNavigationHistory(): TaskNavigationHistory {
  return { entries: [], cursor: -1 };
}

export function isTaskNavEntry(entry: WorkspaceNavEntry): entry is TaskNavEntry {
  return entry.kind === "task";
}

export function isAutomationsNavEntry(entry: WorkspaceNavEntry): entry is AutomationsNavEntry {
  return entry.kind === "automations";
}

export function isPluginStoreNavEntry(entry: WorkspaceNavEntry): entry is PluginStoreNavEntry {
  return entry.kind === "plugin-store";
}

function isSameNavEntry(left: WorkspaceNavEntry, right: WorkspaceNavEntry): boolean {
  if (
    left.kind !== right.kind ||
    left.workspacePath !== right.workspacePath ||
    left.workspaceIdentity !== right.workspaceIdentity
  ) {
    return false;
  }

  if (left.kind === "task") return left.taskId === (right as TaskNavEntry).taskId;
  if (left.kind === "automations") {
    const rightAutomations = right as AutomationsNavEntry;
    return (
      left.automationId === rightAutomations.automationId &&
      left.automationTab === rightAutomations.automationTab
    );
  }
  return true;
}

function pushEntry(
  history: TaskNavigationHistory,
  entry: WorkspaceNavEntry,
): TaskNavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;

  // Deduplicate adjacent entries: replaying history or repeatedly opening the same target should not add duplicates.
  if (current && isSameNavEntry(current, entry)) {
    return history;
  }

  // Truncate forward history after the cursor to preserve browser-style navigation semantics.
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > MAX_HISTORY) {
    const overflow = next.length - MAX_HISTORY;
    return {
      entries: next.slice(overflow),
      cursor: next.length - overflow - 1,
    };
  }

  return { entries: next, cursor: next.length - 1 };
}

/** Called when the user selects or creates a task. */
export function pushNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  // Navigation for a remote workspace cannot be keyed by path alone.
  // The same path may exist locally, remotely, or on multiple remote machines, so include the identity isolation key in the history entry.
  return pushEntry(history, {
    kind: "task",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    taskId,
  });
}

/** Called when the user opens the Automations main view or a specific detail. */
export function pushAutomationsNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "automations",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(automationId ? { automationId } : {}),
    ...(automationTab ? { automationTab } : {}),
  });
}

export function pushPluginStoreNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "plugin-store",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

export function canGoBack(history: TaskNavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: TaskNavigationHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** Move back one step and return the new history and target entry. */
export function goBack(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoBack(history)) {
    return null;
  }

  const nextCursor = history.cursor - 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/** Move forward one step and return the new history and target entry. */
export function goForward(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoForward(history)) {
    return null;
  }

  const nextCursor = history.cursor + 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/**
 * Keeps the cursor on the same surviving entry. When the current entry was removed, it moves to the
 * first survivor after the removed position, counting only survivors before the old cursor so earlier removals cannot overshoot.
 */
function cursorAfterRemoval(
  entries: readonly WorkspaceNavEntry[],
  kept: readonly WorkspaceNavEntry[],
  cursor: number,
): number {
  if (kept.length === 0) {
    return -1;
  }

  const current = cursor >= 0 ? entries[cursor] : undefined;
  const keptIndex = current ? kept.indexOf(current) : -1;
  if (keptIndex >= 0) {
    return keptIndex;
  }

  const survivorsBeforeCursor = entries
    .slice(0, Math.max(cursor, 0))
    .filter((entry) => kept.includes(entry)).length;
  return Math.min(survivorsBeforeCursor, kept.length - 1);
}

/**
 * Remove all task entries with the given taskId from history (called when a task is deleted).
 * Automations entries are not part of the task lifecycle and must be preserved as-is.
 */
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const kept = history.entries.filter((entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId);

  if (kept.length === history.entries.length) {
    return history;
  }

  if (kept.length === 0) {
    return createTaskNavigationHistory();
  }

  return { entries: kept, cursor: cursorAfterRemoval(history.entries, kept, history.cursor) };
}

export type TaskNavigationDirection = "back" | "forward";

export interface TaskNavigationStep {
  history: TaskNavigationHistory;
  /** Entry to open, or null when nothing reachable remains in that direction. */
  entry: WorkspaceNavEntry | null;
}

/**
 * Moves one step in `direction`, purging task entries whose target `isAvailable` rejects.
 *
 * The walk and the purge are computed from one snapshot, so a purged entry never shifts the cursor that
 * the next step reads. Replaying back or forward therefore visits surviving entries in their recorded order.
 * When nothing reachable remains, only the purge is kept and the cursor stays on the current entry.
 */
export function stepTaskNavigationHistory(
  history: TaskNavigationHistory,
  direction: TaskNavigationDirection,
  isAvailable: (entry: TaskNavEntry) => boolean,
): TaskNavigationStep {
  const stride = direction === "back" ? -1 : 1;
  const unavailableTaskIds = new Set<string>();
  let target: WorkspaceNavEntry | undefined;

  for (
    let index = history.cursor + stride;
    index >= 0 && index < history.entries.length;
    index += stride
  ) {
    const entry = history.entries[index];
    if (!entry) {
      break;
    }
    if (isTaskNavEntry(entry)) {
      if (unavailableTaskIds.has(entry.taskId)) {
        continue;
      }
      if (!isAvailable(entry)) {
        unavailableTaskIds.add(entry.taskId);
        continue;
      }
    }
    target = entry;
    break;
  }

  const kept =
    unavailableTaskIds.size === 0
      ? history.entries
      : history.entries.filter(
          (entry) => !(isTaskNavEntry(entry) && unavailableTaskIds.has(entry.taskId)),
        );

  if (target) {
    return { history: { entries: kept, cursor: kept.indexOf(target) }, entry: target };
  }

  if (kept.length === history.entries.length) {
    return { history, entry: null };
  }
  return {
    history: { entries: kept, cursor: cursorAfterRemoval(history.entries, kept, history.cursor) },
    entry: null,
  };
}
