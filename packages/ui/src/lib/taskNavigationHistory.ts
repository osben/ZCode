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

function isTaskNavEntry(entry: WorkspaceNavEntry): entry is TaskNavEntry {
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
 * Remove all task entries with the given taskId from history (called when a task is deleted).
 * Automations entries are not part of the task lifecycle and must be preserved as-is.
 */
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const currentEntry = history.cursor >= 0 ? history.entries[history.cursor] : null;
  const filtered = history.entries.filter(
    (entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId,
  );

  if (filtered.length === history.entries.length) {
    return history;
  }

  if (filtered.length === 0) {
    return createTaskNavigationHistory();
  }

  // Keep pointing to the current entry if it was not removed; otherwise use its former position to select the nearest target.
  const currentEntryIndex = currentEntry ? filtered.indexOf(currentEntry) : -1;
  const cursor =
    currentEntryIndex >= 0 ? currentEntryIndex : Math.min(history.cursor, filtered.length - 1);

  return { entries: filtered, cursor };
}
