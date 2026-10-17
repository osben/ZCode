interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CHILD_SESSION_EXPANSION_STORAGE_KEY = "zcode-child-session-expansion";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type ChildSessionExpansionState = Record<string, true>;

function normalizeChildSessionExpansionState(value: unknown): ChildSessionExpansionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, true] => typeof entry[0] === "string" && entry[1] === true,
    ),
  );
}

/**
 * Per-device sidebar expansion of a parent task's child-conversation list
 * (spec: sidebar-child-conversation-counts.md §4). Collapsed is the default, so only explicitly
 * expanded parent ids are stored; a plain Record<id, true> keeps the payload small.
 */
export function readChildSessionExpansionState(
  storage: StorageLike | null = getBrowserStorage(),
): ChildSessionExpansionState {
  const rawValue = storage?.getItem(CHILD_SESSION_EXPANSION_STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    return normalizeChildSessionExpansionState(JSON.parse(rawValue));
  } catch {
    return {};
  }
}

export function isChildSessionsExpanded(
  parentSessionId: string,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  return readChildSessionExpansionState(storage)[parentSessionId] === true;
}

export function persistChildSessionsExpanded(
  parentSessionId: string,
  expanded: boolean,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  const currentState = readChildSessionExpansionState(storage);
  const nextState = expanded
    ? { ...currentState, [parentSessionId]: true as const }
    : Object.fromEntries(Object.entries(currentState).filter(([key]) => key !== parentSessionId));
  try {
    storage.setItem(CHILD_SESSION_EXPANSION_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // Expansion is a local preference; storage failure must not break the toggle.
  }
}
