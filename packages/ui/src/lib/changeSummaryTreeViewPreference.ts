interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY = "zcode-change-summary-tree-view";

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

export function readChangeSummaryTreeViewPreference(
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  try {
    return storage?.getItem(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistChangeSummaryTreeViewPreference(
  enabled: boolean,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    if (enabled) {
      storage?.setItem(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY, "true");
    } else {
      storage?.removeItem?.(CHANGE_SUMMARY_TREE_VIEW_STORAGE_KEY);
    }
  } catch {
    // Storage may be unavailable (private mode); the preference is best-effort.
  }
}
