import { useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  createWorkerWorkspaceFileSearchFilterBackend,
  type WorkspaceFileSearchFilterBackend,
} from "./workspaceFileSearchFilterBackend.js";

interface UseWorkspaceFileSearchFilterOptions {
  requireQuery?: boolean;
  limit?: number;
}

interface WorkspaceFileSearchFilterState {
  /** Ordered list of original entries filtered by query and mapped back. */
  items: WorkspaceFileEntry[];
  /**
   * Whether filtering for the current query is still in flight (asynchronous Worker). Callers should treat an in-flight result as “unknown”
   * in miss-detection scenarios to avoid triggering an action from a temporarily empty list.
   */
  filtering: boolean;
}

/**
 * Shared entry point for workspace-file search filtering: candidate scoring runs in a Web Worker (with synchronous main-thread fallback),
 * and returns mapped entries. @-file candidates and file-tree search share the same semantics.
 *
 * Timing contract:
 * - When entries change (index rebuild), clear items before filtering asynchronously; old results cannot leak into the new index.
 * - The backend seq mechanism discards stale results from query changes (resolves to null).
 * - The main thread does not build a full Map/candidate set (it previously blocked synchronously for ~630 ms with 370,000 entries;
 *   this work has moved entirely to the worker), and the component disposes the worker on unmount.
 */
export function useWorkspaceFileSearchFilterEntries(
  packed: string,
  query: string,
  options: UseWorkspaceFileSearchFilterOptions,
  rootPath: string,
): WorkspaceFileSearchFilterState {
  const backendRef = useRef<WorkspaceFileSearchFilterBackend | null>(null);
  if (backendRef.current === null) {
    backendRef.current = createWorkerWorkspaceFileSearchFilterBackend();
  }
  const [items, setItems] = useState<WorkspaceFileEntry[]>([]);
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    // Index rebuild: clear old results (filtering for the new index has not run yet), then send all candidates directly as packed data.
    setItems([]);
    backend.setPacked(packed, rootPath);
  }, [backendRef, packed, rootPath]);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    let cancelled = false;
    setFiltering(true);
    void backend.filter(query, options).then((result) => {
      if (cancelled) {
        return;
      }
      setFiltering(false);
      if (result === null) {
        // For stale results (after an index rebuild or newer filter), leave the current items unchanged.
        return;
      }
      setItems(result);
    });
    return () => {
      cancelled = true;
    };
    // entries must be a dependency: restart filtering after an index rebuild (setEntries), or the results
    // will remain the old index’s empty list (this trigger was accidentally removed when entryMap was deleted).
    // options is a new object literal on every render; depend on its expanded fields to avoid refiltering every frame.
  }, [backendRef, options.limit, options.requireQuery, packed, query, rootPath]);

  useEffect(() => {
    return () => {
      backendRef.current?.dispose();
      backendRef.current = null;
    };
  }, [backendRef]);

  return { items, filtering };
}
