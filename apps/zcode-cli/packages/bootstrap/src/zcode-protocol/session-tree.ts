// session/treeCounts and session/eraseTree (specs/session-deletion-cascade.md §4-§6).
// The store owns the database rows; this module owns the process-local facts the store cannot know
// (live runtimes, busy turns) and the per-session directories under the CLI storage root.
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { SessionId } from "@zcode/contracts";
import {
  zcodeSessionEraseTreeParamsSchema,
  zcodeSessionTreeCountsParamsSchema,
  type ZCodeSessionEraseTreeResult,
  type ZCodeSessionTreeCountsResult,
} from "@zcode/shared";
import { isRecordBusy } from "../zcode-protocol-v4/child-session-facts.js";
import { closeSession } from "./server-operations.js";
import {
  ProtocolRequestError,
  parseParams,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * Directories under `<storageRoot>/cli` that are keyed by exactly the session id
 * (tool artifacts, derived media caches, script-workflow files). bash-startup and persisted exec
 * output are keyed under roots the protocol server does not know, so they are left in place.
 */
const PER_SESSION_DIRECTORIES = [
  "artifacts",
  "image-cache",
  "pdf-cache",
  "video-cache",
  "sessions",
] as const;

/** Matches what the artifact store's path sanitizer leaves unchanged, so the segment equals the id. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/u;

/** Ids whose directory name is the id itself; anything else cannot be located safely and is left alone. */
function isPlainSegment(sessionId: string): boolean {
  return SAFE_SEGMENT.test(sessionId) && sessionId !== "." && sessionId !== "..";
}

function requireTreeStore(context: ZCodeProtocolAgentServerContext) {
  const store = context.deps.sessionStore;
  if (!store?.countSessionTree || !store.listSessionTreeIds || !store.deleteSessionTree) {
    // Same code as an unknown method, so callers have a single "unsupported" path.
    throw new ProtocolRequestError(-32601, "Session tree operations are not supported");
  }
  return store;
}

function findRunningSessionIds(
  context: ZCodeProtocolAgentServerContext,
  sessionIds: readonly string[],
): string[] {
  const inTree = new Set(sessionIds);
  const running = new Set<string>();
  for (const sessionId of sessionIds) {
    const record = context.sessions.get(sessionId);
    if (record && isRecordBusy(record)) running.add(sessionId);
  }
  // Detached subagents have no host session record; the gateway owns their lifecycle.
  for (const child of context.v4Gateway?.getDetachedChildSessionFacts() ?? []) {
    if (child.running && inTree.has(child.sessionId)) running.add(child.sessionId);
  }
  return [...running];
}

export async function countSessionTrees(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionTreeCountsResult> {
  const params = parseParams(zcodeSessionTreeCountsParamsSchema, rawParams);
  const store = requireTreeStore(context);
  const rootIds = params.sessionIds as SessionId[];
  const [counts, treeIds] = await Promise.all([
    store.countSessionTree!({ rootIds }),
    store.listSessionTreeIds!({ rootIds }),
  ]);
  return { ...counts, running: findRunningSessionIds(context, treeIds).length };
}

async function removeSessionDirectories(
  storageRoot: string | undefined,
  sessionIds: readonly string[],
): Promise<number> {
  // Without a storage root (embedded callers) there is nothing to resolve; the rows are still erased.
  if (!storageRoot) return 0;
  let failures = 0;
  for (const sessionId of sessionIds) {
    if (!isPlainSegment(sessionId)) continue;
    for (const directory of PER_SESSION_DIRECTORIES) {
      // Same join as the writers (create-app.ts, script-workflow-tool-port.ts); not getCliStorageRoot().
      const root = join(storageRoot, "cli", directory);
      const target = join(root, sessionId);
      const fromRoot = relative(root, target);
      // Defense in depth: only ever delete a direct child of a known root.
      if (fromRoot !== sessionId || isAbsolute(fromRoot)) {
        failures += 1;
        continue;
      }
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        failures += 1;
      }
    }
  }
  return failures;
}

export async function eraseSessionTrees(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionEraseTreeResult> {
  const params = parseParams(zcodeSessionEraseTreeParamsSchema, rawParams);
  const store = requireTreeStore(context);
  const rootIds = params.sessionIds as SessionId[];
  const treeIds = (await store.listSessionTreeIds!({ rootIds })).map(String);

  // The running guard is process-local: the session database has no lease, so a turn running in
  // another window's CLI process is not visible here (spec §4).
  const running = findRunningSessionIds(context, treeIds);
  if (running.length > 0) {
    return {
      erasedSessionIds: [],
      blockedRunningSessionIds: running,
      fileFailureCount: 0,
      filesRetainedCount: 0,
    };
  }

  // Close idle resident runtimes first so no late write can recreate a row after the delete.
  for (const sessionId of treeIds) {
    if (context.sessions.has(sessionId)) await closeSession(context, { sessionId });
  }

  // Files go before the rows. If removal fails or the process dies midway, the rows still exist, so a
  // retry finds the same tree and finishes the cleanup instead of losing track of the directories.
  // Directories of sessions that a surviving fork points at are kept: the fork's copied parts still
  // resolve artifact and media URLs to the source session's directory.
  const retained = new Set(
    (await store.listSessionTreeIdsWithSurvivingChildren?.({ rootIds }))?.map(String) ?? [],
  );
  for (const sessionId of treeIds) {
    if (!isPlainSegment(sessionId)) retained.add(sessionId);
  }
  const fileFailureCount = await removeSessionDirectories(
    context.deps.storageRoot,
    treeIds.filter((sessionId) => !retained.has(sessionId)),
  );
  if (fileFailureCount > 0) {
    return {
      erasedSessionIds: [],
      blockedRunningSessionIds: [],
      fileFailureCount,
      filesRetainedCount: retained.size,
    };
  }

  const { erasedIds } = await store.deleteSessionTree!({ rootIds });
  const erasedSessionIds = erasedIds.map(String);
  // A child created between the listing and the delete is erased too; its directory is best effort.
  const lateFailures = await removeSessionDirectories(
    context.deps.storageRoot,
    erasedSessionIds.filter((sessionId) => !treeIds.includes(sessionId)),
  );
  context.logger?.info("ZCode Protocol session tree erased", {
    event: "zcode_protocol.session.tree_erased",
    module: "bootstrap.zcode_protocol",
    operation: "session_erase_tree",
    requestedRootCount: rootIds.length,
    erasedSessionCount: erasedSessionIds.length,
    fileFailureCount: lateFailures,
    filesRetainedCount: retained.size,
  });
  return {
    erasedSessionIds,
    blockedRunningSessionIds: [],
    fileFailureCount: lateFailures,
    filesRetainedCount: retained.size,
  };
}
