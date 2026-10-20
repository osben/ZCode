import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Workspace file-search filter Worker: holds all candidates, receives queries, and scores/selects top-K on a background thread,
 * then returns mapped entries (≤limit) so scoring and moving hundreds of thousands of candidates do not block the main thread.
 * The logic reuses the main-thread pure function (workspaceFileSearch.ts), so behavior matches the fallback path;
 * entries are sent as a columnar packed string (see the backend comment).
 */

let entries: WorkspaceFileEntry[] = [];
let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
let byId: Map<string, WorkspaceFileEntry> = new Map();

self.onmessage = (
  event: MessageEvent<{
    type: string;
    seq?: number;
    query?: string;
    options?: FilterWorkspaceFileSearchCandidatesOptions;
    packed?: string;
    rootPath?: string;
  }>,
) => {
  const data = event.data;
  if (data.type === "entries" && typeof data.packed === "string") {
    entries = unpackWorkspaceFileEntries(
      data.packed,
      typeof data.rootPath === "string" ? data.rootPath : "",
    );
    candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
    byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    return;
  }
  if (data.type === "filter" && typeof data.seq === "number" && typeof data.query === "string") {
    const result = filterWorkspaceFileSearchCandidates(candidates, data.query, data.options ?? {})
      .map((candidate) => byId.get(candidate.id) ?? null)
      .filter((entry): entry is WorkspaceFileEntry => entry !== null);
    (self as unknown as Worker).postMessage({ type: "result", seq: data.seq, entries: result });
  }
};
