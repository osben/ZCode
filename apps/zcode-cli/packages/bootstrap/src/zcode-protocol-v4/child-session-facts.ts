// Bridge-level resolver for sidebar child-conversation facts (spec: sidebar-child-conversation-counts.md §3).
// The live sessions-index hook is synchronous, so store reads go through a small TTL cache that
// refreshes asynchronously: a derive pass serves cached values and a refresh lands within the TTL
// plus the next fan-out. Only parents known to have children are refreshed (cold seed ∪ live
// registry scan), so plain workspaces cost nothing. Extracted from v4-bridge so the cache and
// staleness rules get direct unit tests.
import type { ChildSessionInfo, SessionId, SessionStorePort } from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { SESSION_SUMMARY_CHILD_SESSIONS_MAX } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolSessionRecord } from "../zcode-protocol/server-types.js";

const CHILD_SESSION_FACTS_TTL_MS = 1_000;

interface ChildSessionFactsLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ChildSessionFactsResolver {
  /** Register parents that (may) have children; the cold seed calls this with its batch keys. */
  noteParents(parentKeys: Iterable<string>): void;
  /** Cold-path store reads for many parents (one query pair); no caching side effects. */
  fetch(
    parentIds: readonly SessionId[],
  ): Promise<
    [Map<string, { sideChats: number; subagents: number }>, Map<string, ChildSessionInfo[]>]
  >;
  /** Live-path summary fragment for one parent; empty object when no facts are known. */
  resolve(sessionId: string): {
    sideChatCount?: number;
    subagentCount?: number;
    runningSubagentCount?: number;
    childSessions?: SessionSummary["childSessions"];
  };
}

/** ChildSessionInfo → the wire summary shape; `running` comes from the live registry (false on the cold path). */
export function toWireChildSession(child: ChildSessionInfo, running: boolean) {
  return {
    sessionId: child.id,
    title: child.title,
    taskType: child.taskType,
    lastActivityAt: child.lastActivityAt,
    running,
  };
}

/**
 * A resident-but-idle child must not render the running spinner: finished sessions stay in the
 * registry until the residency pool reclaims them, so mere presence is not execution. The busy
 * predicate mirrors the pool's hasResidencyBlockingWork (session-residency.ts) — a turn in flight
 * or runtime-claimed blocking work.
 */
function isRecordBusy(record: ZCodeProtocolSessionRecord): boolean {
  return (
    record.activeAbortController !== undefined ||
    (record.residencyFinalizationCount ?? 0) > 0 ||
    record.app.runtime.hasResidencyBlockingWork()
  );
}

export function createChildSessionFactsResolver(deps: {
  store: () => SessionStorePort | undefined;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  logger?: ChildSessionFactsLogger;
  now?: () => number;
}): ChildSessionFactsResolver {
  const now = deps.now ?? (() => Date.now());
  const cache = {
    at: 0,
    counts: new Map<string, { sideChats: number; subagents: number }>(),
    children: new Map<string, ChildSessionInfo[]>(),
  };
  const seenParentIds = new Set<string>();
  let refreshing = false;

  const liveSubagentChildCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const record of deps.sessions.values()) {
      if (record.taskType !== "subagent_child" || !record.parentSessionId) continue;
      // Count only busy children: finished-but-resident sessions must not keep the parent's
      // running count alive (same predicate as the per-child running flag below).
      if (!isRecordBusy(record)) continue;
      const parentKey = String(record.parentSessionId);
      counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
    }
    for (const parentKey of counts.keys()) seenParentIds.add(parentKey);
    return counts;
  };

  const scheduleRefresh = () => {
    const store = deps.store();
    if (!store || refreshing || seenParentIds.size === 0) return;
    if (now() - cache.at <= CHILD_SESSION_FACTS_TTL_MS) return;
    refreshing = true;
    const parentIds = [...seenParentIds] as SessionId[];
    void Promise.all([
      store.countChildSessions({ parentIds }),
      store.listChildSessions({ parentIds, limitPerParent: SESSION_SUMMARY_CHILD_SESSIONS_MAX }),
    ])
      .then(([counts, children]) => {
        cache.at = now();
        cache.counts = counts;
        cache.children = children;
      })
      .catch((error: unknown) => {
        // Advance the TTL window on failure too: a persistently failing store must not turn every
        // fan-out into an immediate retry + warn loop.
        cache.at = now();
        deps.logger?.warn("child session facts refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "zcode_protocol.v4.child_session_facts_failed",
          module: "bootstrap.zcode_protocol",
        });
      })
      .finally(() => {
        refreshing = false;
      });
  };

  return {
    noteParents(parentKeys) {
      for (const parentKey of parentKeys) seenParentIds.add(parentKey);
    },
    fetch(parentIds) {
      const store = deps.store();
      if (!store) {
        return Promise.resolve([new Map(), new Map()] as const);
      }
      return Promise.all([
        store.countChildSessions({ parentIds }),
        store.listChildSessions({ parentIds, limitPerParent: SESSION_SUMMARY_CHILD_SESSIONS_MAX }),
      ]);
    },
    resolve(sessionId) {
      const liveSubagents = liveSubagentChildCounts();
      scheduleRefresh();
      const counts = cache.counts.get(sessionId);
      const children = cache.children.get(sessionId) ?? [];
      const runningSubagentCount = liveSubagents.get(sessionId) ?? 0;
      return {
        ...(counts?.sideChats ? { sideChatCount: counts.sideChats } : {}),
        ...(counts?.subagents ? { subagentCount: counts.subagents } : {}),
        ...(runningSubagentCount > 0 ? { runningSubagentCount } : {}),
        ...(children.length > 0
          ? {
              childSessions: children.map((child) => {
                // Only subagent children can execute work; a side chat merely being open in a
                // pane must not render the running spinner.
                const childRecord =
                  child.taskType === "subagent_child" ? deps.sessions.get(child.id) : undefined;
                return toWireChildSession(
                  child,
                  childRecord !== undefined && isRecordBusy(childRecord),
                );
              }),
            }
          : {}),
      };
    },
  };
}
