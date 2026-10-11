import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** Decode the existing packed index in batches so a long Renderer task is not simply moved to the shared Host. */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  let best: WorkspaceFileSearchCandidate[] = [];
  // Process top-K inputs in batches in their original index order; ties retain stable order, making batched merging match sorting the full table.
  for (let offset = 0; offset < candidates.length; offset += 2048) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + 2048)],
      query,
      { limit },
    );
    await setImmediate();
  }
  return best.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
