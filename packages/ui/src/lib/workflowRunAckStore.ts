// Acknowledged workflow runs.
// Keep completed run rows visible until the user opens that conversation — no timer or settledAt, only this bounded,
// persisted set of runIds: when opening a conversation, add all runs that were completed at that point. Desktop uses localStorage;
// mobile remote control runs the same code in its own browser and uses its own storage.
import { useMemo, useSyncExternalStore } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const WORKFLOW_RUN_ACK_STORAGE_KEY = "zcode-workflow-run-acknowledged";
/** Maximum set size; evict the earliest acknowledged item when full. 256 is far more than the number of completed runs visible in any conversation list. */
const WORKFLOW_RUN_ACK_LIMIT = 256;

interface WorkflowRunAckStore {
  isAcknowledged(runId: string): boolean;
  acknowledge(runIds: readonly string[]): void;
  subscribe(listener: () => void): () => void;
  /** Version snapshot: increment on each set change for useSyncExternalStore comparisons. */
  getVersion(): number;
}

function readStored(storage: StorageLike | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(WORKFLOW_RUN_ACK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function createWorkflowRunAckStore(storage: StorageLike | null): WorkflowRunAckStore {
  // Insertion order = acknowledgement order; Set iteration order ensures the earliest item is evicted first.
  const acknowledged = new Set<string>(readStored(storage).slice(-WORKFLOW_RUN_ACK_LIMIT));
  const listeners = new Set<() => void>();
  let version = 0;
  const persist = () => {
    if (storage === null) return;
    try {
      storage.setItem(WORKFLOW_RUN_ACK_STORAGE_KEY, JSON.stringify([...acknowledged]));
    } catch {
      // If storage is unavailable (private browsing, quota), it still works for this session but does not survive restarts.
    }
  };
  return {
    isAcknowledged: (runId) => acknowledged.has(runId),
    acknowledge: (runIds) => {
      let changed = false;
      for (const runId of runIds) {
        if (acknowledged.has(runId)) continue;
        acknowledged.add(runId);
        changed = true;
      }
      if (!changed) return;
      while (acknowledged.size > WORKFLOW_RUN_ACK_LIMIT) {
        const oldest = acknowledged.values().next().value;
        if (oldest === undefined) break;
        acknowledged.delete(oldest);
      }
      version += 1;
      persist();
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let defaultStore: WorkflowRunAckStore | null = null;

export function getWorkflowRunAckStore(): WorkflowRunAckStore {
  defaultStore ??= createWorkflowRunAckStore(getBrowserStorage());
  return defaultStore;
}

/** Subscribe to the acknowledged-set version; the returned predicate gets a new reference when the version changes so callers recompute row selection. */
export function useWorkflowRunAcknowledged(): (runId: string) => boolean {
  const store = getWorkflowRunAckStore();
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // Change the predicate reference with the version: callers put it in useMemo dependencies so row selection recomputes when the set changes.
  return useMemo(() => (runId: string) => store.isAcknowledged(runId), [store, version]);
}
