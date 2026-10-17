export type GitPaneFileListLayout = "directory" | "flat";

export const DEFAULT_GIT_PANE_FILE_LIST_LAYOUT: GitPaneFileListLayout = "directory";

const GIT_PANE_FILE_LIST_LAYOUT_STORAGE_KEY = "zcode-git-pane-file-list-layout";

const LAYOUT_VALUES: readonly GitPaneFileListLayout[] = ["directory", "flat"];

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

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

export function readGitPaneFileListLayout(
  storage: StorageLike | null = getBrowserStorage(),
): GitPaneFileListLayout {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(GIT_PANE_FILE_LIST_LAYOUT_STORAGE_KEY) ?? null;
  } catch {
    return DEFAULT_GIT_PANE_FILE_LIST_LAYOUT;
  }

  return LAYOUT_VALUES.includes(rawValue as GitPaneFileListLayout)
    ? (rawValue as GitPaneFileListLayout)
    : DEFAULT_GIT_PANE_FILE_LIST_LAYOUT;
}

export function writeGitPaneFileListLayout(
  layout: GitPaneFileListLayout,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(GIT_PANE_FILE_LIST_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // The layout preference is best-effort; a full or blocked storage must not break the pane.
  }
}
