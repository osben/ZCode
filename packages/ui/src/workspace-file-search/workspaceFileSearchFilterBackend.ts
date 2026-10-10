import type { WorkspaceFileEntry } from "@zcode/shared";
import { logger } from "@/logger.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";

/**
 * Workspace-file search filter backend abstraction: execution location for candidate scoring and top-K sorting.
 *
 * Background: After allowing directories such as node_modules, the candidate count
 * can reach hundreds of thousands, and synchronous main-thread scoring blocks input for 50–300 ms per key; scoring has moved to a Web Worker.
 * Data transfer cannot use structured cloning either: cloning 370,000 entries through postMessage took ~471 ms
 * of synchronous main-thread blocking (one cause of the @ panel freezing the whole window for seconds), so worker transport now uses
 * a columnar packed string (~31 ms measured), which the worker decodes to build candidates.
 *
 * The synchronous implementation remains for two purposes: (1) fallback when Worker is unavailable/fails, preserving previous behavior;
 * (2) injection in unit-test environments (Node has no Web Worker).
 */
export interface WorkspaceFileSearchFilterBackend {
  /** Update all candidates (columnar packed string + rootPath used to reconstruct name/path); existing filter results become invalid afterward. */
  setPacked(packed: string, rootPath: string): void;
  /**
   * Filter by query and return an ordered entry list mapped back to original objects (≤limit).
   * The Promise never rejects: stale results (after setEntries or a newer filter) resolve to null,
   * which tells callers to discard them.
   */
  filter(
    query: string,
    options: FilterWorkspaceFileSearchCandidatesOptions,
  ): Promise<WorkspaceFileEntry[] | null>;
  dispose(): void;
}

function createSyncWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
  let byId: Map<string, WorkspaceFileEntry> = new Map();
  return {
    setPacked(packed, rootPath) {
      const entries = unpackWorkspaceFileEntries(packed, rootPath);
      candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
      byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    },
    filter(query, options) {
      return Promise.resolve(
        filterWorkspaceFileSearchCandidates(candidates, query, options)
          .map((candidate) => byId.get(candidate.id) ?? null)
          .filter((entry): entry is WorkspaceFileEntry => entry !== null),
      );
    },
    dispose() {
      candidates = [];
      byId = new Map();
    },
  };
}

export function createWorkerWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  // The Node test environment (vitest node project) has no module-worker runtime, so it uses the synchronous path;
  // environments such as jsdom, which have document but no Worker implementation, fall back in the try/catch below.
  if (typeof document === "undefined") {
    return createSyncWorkspaceFileSearchFilterBackend();
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./workspaceFileSearchFilter.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-workspace-file-search",
    });
  } catch (error) {
    // Fallback path: use synchronous scoring if a very old event loop or test environment does not support module workers.
    logger.warn("[workspace-file-search] Worker 创建失败，回退主线程同步过滤", {
      error: error instanceof Error ? error.message : String(error),
    });
    return createSyncWorkspaceFileSearchFilterBackend();
  }

  let seq = 0;
  const pending = new Map<number, { resolve: (entries: WorkspaceFileEntry[] | null) => void }>();

  worker.onmessage = (
    event: MessageEvent<{ type: string; seq?: number; entries?: WorkspaceFileEntry[] }>,
  ) => {
    const data = event.data;
    if (data.type !== "result" || typeof data.seq !== "number") {
      return;
    }
    const waiter = pending.get(data.seq);
    if (!waiter) {
      return;
    }
    pending.delete(data.seq);
    waiter.resolve(Array.isArray(data.entries) ? data.entries : null);
  };

  worker.onerror = (event) => {
    // Runtime failure: expire all in-flight requests (null); later filters still retry;
    // callers can detect persistent failure through empty results without blocking input.
    logger.warn("[workspace-file-search] Worker 运行失败，本轮过滤结果丢弃", {
      message: event.message,
    });
    for (const [, waiter] of pending) {
      waiter.resolve(null);
    }
    pending.clear();
  };

  return {
    setPacked(packed, rootPath) {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      // packed data is produced directly by Host’s listWorkspaceFiles (RPC returns a string with memcpy-level transfer),
      // so the renderer never builds entry objects; with 370,000 files, this avoided 11–14 seconds of structured cloning in measurements.
      worker.postMessage({ type: "entries", packed, rootPath });
    },
    filter(query, options) {
      seq += 1;
      const currentSeq = seq;
      return new Promise<WorkspaceFileEntry[] | null>((resolve) => {
        pending.set(currentSeq, { resolve });
        worker.postMessage({
          type: "filter",
          seq: currentSeq,
          query,
          options,
        });
      });
    },
    dispose() {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      worker.terminate();
    },
  };
}
