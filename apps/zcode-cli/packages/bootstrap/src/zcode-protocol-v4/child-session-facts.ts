// Bridge-level resolver for sidebar child-conversation facts (spec: sidebar-child-conversation-counts.md
// §3, §9). The sidebar lists side chats only. The live sessions-index hook is synchronous, so store
// reads refresh a per-parent TTL cache in the background.
import type { ChildSessionInfo, SessionId, SessionStorePort, SessionTaskType } from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { SESSION_SUMMARY_CHILD_SESSIONS_MAX } from "@zcode/shared/zcode-protocol-v4";

/**
 * Structural view of a live session record. The v4 directory must not import the legacy protocol
 * directory (v4-native-boundary), so the legacy registry entries are passed in by shape.
 */
interface ChildSessionRecordView {
  taskType?: SessionTaskType;
  parentSessionId?: string;
}

const CHILD_SESSION_FACTS_TTL_MS = 1_000;

interface ChildSessionFactsLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ChildSessionFactsResolver {
  /** Register parents that may have children; cold seed and live discovery call this. */
  noteParents(parentKeys: Iterable<string>): void;
  /** Cold-path store reads for many parents (one query pair). */
  loadStoredFacts(
    parentIds: readonly SessionId[],
  ): Promise<[Map<string, { sideChats: number }>, Map<string, ChildSessionInfo[]>]>;
  /** Seed the live cache before loaded-session summaries overlay the cold index snapshot. */
  seed(
    parentIds: readonly SessionId[],
    counts: Map<string, { sideChats: number }>,
    children: Map<string, ChildSessionInfo[]>,
  ): void;
  /** Invalidate affected parents and refresh their store facts, respecting the TTL. */
  refresh(parentKeys: Iterable<string>): Promise<void>;
  /** Mark parents stale after a child lifecycle event. */
  invalidate(parentKeys: Iterable<string>): void;
  /** Live-path summary fragment for one parent; empty object when no facts are known. */
  resolve(sessionId: string): {
    sideChatCount?: number;
    childSessions?: SessionSummary["childSessions"];
  };
}

/** ChildSessionInfo → the wire summary shape. `running` stays on the wire for older UIs (§9.2). */
export function toWireChildSession(child: ChildSessionInfo) {
  return {
    sessionId: child.id,
    title: child.title,
    taskType: child.taskType,
    lastActivityAt: child.lastActivityAt,
    running: false,
  };
}

export function createChildSessionFactsResolver(deps: {
  store: () => SessionStorePort | undefined;
  sessions: Map<string, ChildSessionRecordView>;
  onRefresh?: (parentKeys: readonly string[]) => void;
  logger?: ChildSessionFactsLogger;
  now?: () => number;
}): ChildSessionFactsResolver {
  const now = deps.now ?? (() => Date.now());
  const counts = new Map<string, { sideChats: number }>();
  const children = new Map<string, ChildSessionInfo[]>();
  const updatedAt = new Map<string, number>();
  const generation = new Map<string, number>();
  const seenParentIds = new Set<string>();
  const requestedParentIds = new Set<string>();
  const deferredRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  let refreshInFlight: Promise<void> | null = null;

  const scheduleDeferredRefresh = (key: string, delayMs: number): void => {
    if (deferredRefreshes.has(key)) return;
    const timer = setTimeout(() => {
      deferredRefreshes.delete(key);
      void refresh([key]);
    }, Math.max(1, delayMs));
    (timer as { unref?: () => void }).unref?.();
    deferredRefreshes.set(key, timer);
  };

  const discoverLiveParents = (): void => {
    for (const record of deps.sessions.values()) {
      if (record.taskType === "selection_side_chat" && record.parentSessionId) {
        seenParentIds.add(String(record.parentSessionId));
      }
    }
  };

  const load = async (parentKeys: readonly string[]): Promise<void> => {
    const store = deps.store();
    if (!store || parentKeys.length === 0) return;
    const tokens = new Map(parentKeys.map((key) => [key, generation.get(key) ?? 0]));
    try {
      const [nextCounts, nextChildren] = await Promise.all([
        store.countChildSessions({ parentIds: parentKeys as SessionId[] }),
        store.listChildSessions({
          parentIds: parentKeys as SessionId[],
          limitPerParent: SESSION_SUMMARY_CHILD_SESSIONS_MAX,
        }),
      ]);
      const refreshedAt = now();
      const refreshedParents: string[] = [];
      for (const parentKey of parentKeys) {
        if ((generation.get(parentKey) ?? 0) !== tokens.get(parentKey)) {
          requestedParentIds.add(parentKey);
          continue;
        }
        const count = nextCounts.get(parentKey);
        if (count) counts.set(parentKey, count);
        else counts.delete(parentKey);
        const childList = nextChildren.get(parentKey);
        if (childList?.length) children.set(parentKey, childList);
        else children.delete(parentKey);
        updatedAt.set(parentKey, refreshedAt);
        refreshedParents.push(parentKey);
      }
      if (refreshedParents.length > 0) deps.onRefresh?.(refreshedParents);
    } catch (error) {
      const failedAt = now();
      for (const parentKey of parentKeys) {
        if ((generation.get(parentKey) ?? 0) === tokens.get(parentKey)) {
          updatedAt.set(parentKey, failedAt);
        } else {
          requestedParentIds.add(parentKey);
        }
      }
      deps.logger?.warn("child session facts refresh failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.child_session_facts_failed",
        module: "bootstrap.zcode_protocol",
      });
    }
  };

  const refresh = async (parentKeys: Iterable<string>): Promise<void> => {
    for (const key of parentKeys) {
      seenParentIds.add(key);
      requestedParentIds.add(key);
    }
    if (refreshInFlight) {
      await refreshInFlight;
      if (requestedParentIds.size > 0) await refresh([]);
      return;
    }
    const currentTime = now();
    const targets: string[] = [];
    for (const key of requestedParentIds) {
      const eligibleAt = (updatedAt.get(key) ?? 0) + CHILD_SESSION_FACTS_TTL_MS + 1;
      if (currentTime >= eligibleAt) {
        targets.push(key);
        const timer = deferredRefreshes.get(key);
        if (timer) clearTimeout(timer);
        deferredRefreshes.delete(key);
      } else {
        scheduleDeferredRefresh(key, eligibleAt - currentTime);
      }
    }
    for (const key of targets) requestedParentIds.delete(key);
    if (targets.length === 0) return;
    refreshInFlight = load(targets);
    await refreshInFlight;
    refreshInFlight = null;
    if (requestedParentIds.size > 0) await refresh([]);
  };

  return {
    noteParents(parentKeys) {
      for (const parentKey of parentKeys) seenParentIds.add(parentKey);
    },
    loadStoredFacts(parentIds) {
      const store = deps.store();
      if (!store) return Promise.resolve([new Map(), new Map()] as const);
      return Promise.all([
        store.countChildSessions({ parentIds }),
        store.listChildSessions({ parentIds, limitPerParent: SESSION_SUMMARY_CHILD_SESSIONS_MAX }),
      ]);
    },
    seed(parentIds, nextCounts, nextChildren) {
      const seededAt = now();
      for (const parentId of parentIds) {
        const key = String(parentId);
        const count = nextCounts.get(key);
        if (count) counts.set(key, count);
        else counts.delete(key);
        const childList = nextChildren.get(key);
        if (childList?.length) children.set(key, childList);
        else children.delete(key);
        updatedAt.set(key, seededAt);
        if (count || childList?.length) seenParentIds.add(key);
      }
    },
    refresh,
    invalidate(parentKeys) {
      for (const key of parentKeys) {
        seenParentIds.add(key);
        const lastUpdatedAt = updatedAt.get(key);
        if (lastUpdatedAt === undefined || now() - lastUpdatedAt > CHILD_SESSION_FACTS_TTL_MS) {
          updatedAt.set(key, 0);
        }
        generation.set(key, (generation.get(key) ?? 0) + 1);
        requestedParentIds.add(key);
      }
    },
    resolve(sessionId) {
      discoverLiveParents();
      const staleParents = [...seenParentIds].filter((key) => {
        const lastUpdatedAt = updatedAt.get(key);
        return lastUpdatedAt === undefined || now() - lastUpdatedAt > CHILD_SESSION_FACTS_TTL_MS;
      });
      if (staleParents.length > 0) {
        void refresh(staleParents);
      }
      const count = counts.get(sessionId);
      const childList = children.get(sessionId) ?? [];
      return {
        ...(count?.sideChats ? { sideChatCount: count.sideChats } : {}),
        ...(childList.length > 0 ? { childSessions: childList.map(toWireChildSession) } : {}),
      };
    },
  };
}
