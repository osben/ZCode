import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ZCodeTaskGroupColor } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { TASK_GROUP_COLORS } from "@/workspace-grouped-tasks/types.js";

const WORKSPACE_DISPLAY_STORAGE_KEY = "zcode-workspace-display";

export interface WorkspaceDisplayEntry {
  /** Custom sidebar label; when blank/missing the folder name is used. */
  displayName?: string;
  color?: ZCodeTaskGroupColor;
}

export interface WorkspaceDisplayState {
  entries: Record<string, WorkspaceDisplayEntry>;
  setWorkspaceDisplayName: (workspaceKey: string, displayName: string | null) => void;
  setWorkspaceColor: (workspaceKey: string, color: ZCodeTaskGroupColor | null) => void;
}

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

function isTaskGroupColor(value: unknown): value is ZCodeTaskGroupColor {
  return typeof value === "string" && (TASK_GROUP_COLORS as readonly string[]).includes(value);
}

function normalizeEntries(value: unknown): Record<string, WorkspaceDisplayEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries: Record<string, WorkspaceDisplayEntry> = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry: WorkspaceDisplayEntry = {};
    if (typeof rawEntry.displayName === "string" && rawEntry.displayName.trim().length > 0) {
      entry.displayName = rawEntry.displayName;
    }
    if (isTaskGroupColor(rawEntry.color)) {
      entry.color = rawEntry.color;
    }
    if (Object.keys(entry).length > 0) {
      entries[key] = entry;
    }
  }
  return entries;
}

function readStoredEntries(
  storage: StorageLike | null,
  fallback: Record<string, WorkspaceDisplayEntry> = {},
): Record<string, WorkspaceDisplayEntry> {
  try {
    const rawValue = storage?.getItem(WORKSPACE_DISPLAY_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    return normalizeEntries(JSON.parse(rawValue));
  } catch {
    return fallback;
  }
}

function persistEntries(
  entries: Record<string, WorkspaceDisplayEntry>,
  storage: StorageLike | null,
) {
  try {
    storage?.setItem(WORKSPACE_DISPLAY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Keep the in-memory state when persistence is unavailable.
  }
}

export function createWorkspaceDisplayStore(
  storage: StorageLike | null = getBrowserStorage(),
): UseBoundStore<StoreApi<WorkspaceDisplayState>> {
  return create<WorkspaceDisplayState>()((set, get) => {
    const updateEntry = (
      workspaceKey: string,
      patch: (entry: WorkspaceDisplayEntry) => WorkspaceDisplayEntry | null,
    ) => {
      const entries = storage ? readStoredEntries(storage, get().entries) : get().entries;
      const current = entries[workspaceKey] ?? {};
      const next = patch(current);
      const updatedEntries = { ...entries };
      if (next === null || Object.keys(next).length === 0) {
        delete updatedEntries[workspaceKey];
      } else {
        updatedEntries[workspaceKey] = next;
      }
      persistEntries(updatedEntries, storage);
      set({ entries: updatedEntries });
    };

    return {
      entries: readStoredEntries(storage),

      setWorkspaceDisplayName: (workspaceKey, displayName) => {
        const normalized = displayName?.trim() ? displayName.trim() : null;
        updateEntry(workspaceKey, (entry) => {
          if (normalized === null) {
            // Removing the name must not drop a previously chosen color.
            return entry.color ? { color: entry.color } : null;
          }
          return { ...entry, displayName: normalized };
        });
      },

      setWorkspaceColor: (workspaceKey, color) => {
        updateEntry(workspaceKey, (entry) => {
          if (color === null) {
            // Removing the color must not drop a previously set display name.
            return entry.displayName ? { displayName: entry.displayName } : null;
          }
          return { ...entry, color };
        });
      },
    };
  });
}

/** App-wide singleton backed by browser localStorage (no-op storage outside the renderer). */
export const useWorkspaceDisplayStore = createWorkspaceDisplayStore();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== WORKSPACE_DISPLAY_STORAGE_KEY) return;
    useWorkspaceDisplayStore.setState({ entries: readStoredEntries(getBrowserStorage()) });
  });
}

/** Convenience selector: entry for a workspace with the standard identity fallback. */
export function selectWorkspaceDisplayEntry(
  state: WorkspaceDisplayState,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceDisplayEntry | undefined {
  return state.entries[buildTaskWorkspaceKey(workspacePath, workspaceIdentity)];
}
