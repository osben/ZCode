// Bridge-level resolver for sidebar child-conversation facts (spec: sidebar-child-conversation-counts.md §3).
// The live sessions-index hook is synchronous, so store reads refresh a per-parent TTL cache in the
// background. Live lifecycle state comes from the owner of each runtime: session records for ordinary
// children and the V4 gateway's detached-child registry for subagents without bootstrap records.
import type {
  ChildSessionInfo,
  SessionId,
  SessionStorePort,
  SessionTaskType,
} from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { SESSION_SUMMARY_CHILD_SESSIONS_MAX } from "@zcode/shared/zcode-protocol-v4";

/**
 * Structural view of a live session record. The v4 directory must not import the legacy protocol
 * directory (v4-native-boundary), so the legacy registry entries are passed in by shape.
 */
export interface ChildSessionRecordView {
  app: { runtime: { hasResidencyBlockingWork(): boolean } };
  activeAbortController?: AbortController;
  residencyFinalizationCount?: number;
  taskType?: SessionTaskType;
  parentSessionId?: string;
}

const CHILD_SESSION_FACTS_TTL_MS = 1_000;

interface ChildSessionFactsLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface DetachedChildSessionFact {
  parentSessionId: string;
  sessionId: string;
  running: boolean;
}

export interface ChildSessionFactsResolver {
  /** Register parents that may have children; cold seed and live discovery call this. */
  noteParents(parentKeys: Iterable<string>): void;
  /** Cold-path store reads for many parents (one query pair). */
  loadStoredFacts(
    parentIds: readonly SessionId[],
  ): Promise<
    [Map<string, { sideChats: number; subagents: number }>, Map<string, ChildSessionInfo[]>]
  >;
  /** Seed the live cache before loaded-session summaries overlay the cold index snapshot. */
  seed(
    parentIds: readonly SessionId[],
    counts: Map<string, { sideChats: number; subagents: number }>,
    children: Map<string, ChildSessionInfo[]>,
  ): void;
  /** Invalidate affected parents and refresh their store facts, respecting the TTL. */
  refresh(parentKeys: Iterable<string>): Promise<void>;
  /** Mark parents stale after a child lifecycle event. */
  invalidate(parentKeys: Iterable<string>): void;
  /** Live-path summary fragment for one parent; empty object when no facts are known. */
  resolve(sessionId: string): {
    sideChatCount?: number;
    subagentCount?: number;
    runningSubagentCount?: number;
    childSessions?: SessionSummary["childSessions"];
  };
}

/** ChildSessionInfo → the wire summary shape; `running` comes from the live runtime owners. */
export function toWireChildSession(
  child: ChildSessionInfo,
  running: boolean,
  backgroundWorkId?: string,
) {
  return {
    sessionId: child.id,
    title: child.title,
    taskType: child.taskType,
    lastActivityAt: child.lastActivityAt,
    running,
    // The wire schema requires min length 1; omit the key entirely when absent (§8.3).
    ...(backgroundWorkId ? { backgroundWorkId } : {}),
  };
}

/** Finished-but-resident children must not render the running spinner. */
export function isRecordBusy(record: ChildSessionRecordView): boolean {
  return (
    record.activeAbortController !== undefined ||
    (record.residencyFinalizationCount ?? 0) > 0 ||
    record.app.runtime.hasResidencyBlockingWork()
  );
}

export function createChildSessionFactsResolver(deps: {
  store: () => SessionStorePort | undefined;
  sessions: Map<string, ChildSessionRecordView>;
  getDetachedChildren?: () => readonly DetachedChildSessionFact[];
  /** Live cancellable subagent background works of a parent, keyed by child session id (§8.3). */
  getBackgroundWorkIds?: (parentSessionId: string) => ReadonlyMap<string, string>;
  onRefresh?: (parentKeys: readonly string[]) => void;
  logger?: ChildSessionFactsLogger;
  now?: () => number;
}): ChildSessionFactsResolver {
  const now = deps.now ?? (() => Date.now());
  const counts = new Map<string, { sideChats: number; subagents: number }>();
  const children = new Map<string, ChildSessionInfo[]>();
  const updatedAt = new Map<string, number>();
  const generation = new Map<string, number>();
  const seenParentIds = new Set<string>();
  const requestedParentIds = new Set<string>();
  const deferredRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  const detachedTaskTypes = new Map<string, string | null>();
  const detachedTaskTypeLookups = new Map<string, Promise<void>>();
  const detachedTaskTypeRetryAt = new Map<string, number>();
  let refreshInFlight: Promise<void> | null = null;

  const resolveDetachedTaskType = (sessionId: string, parentSessionId: string): string | null => {
    if (detachedTaskTypes.has(sessionId)) return detachedTaskTypes.get(sessionId) ?? null;
    const store = deps.store();
    if (
      !store ||
      detachedTaskTypeLookups.has(sessionId) ||
      (detachedTaskTypeRetryAt.get(sessionId) ?? 0) > now()
    ) {
      return null;
    }
    const lookup = store
      .getSession(sessionId as SessionId)
      .then((session) => {
        detachedTaskTypes.set(sessionId, session?.taskType ?? null);
        detachedTaskTypeRetryAt.delete(sessionId);
        deps.onRefresh?.([parentSessionId]);
      })
      .catch((error: unknown) => {
        detachedTaskTypeRetryAt.set(sessionId, now() + CHILD_SESSION_FACTS_TTL_MS);
        deps.logger?.warn("detached child task type lookup failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "zcode_protocol.v4.detached_child_task_type_failed",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
      })
      .finally(() => detachedTaskTypeLookups.delete(sessionId));
    detachedTaskTypeLookups.set(sessionId, lookup);
    return null;
  };

  const scheduleDeferredRefresh = (key: string, delayMs: number): void => {
    if (deferredRefreshes.has(key)) return;
    const timer = setTimeout(() => {
      deferredRefreshes.delete(key);
      void refresh([key]);
    }, Math.max(1, delayMs));
    (timer as { unref?: () => void }).unref?.();
    deferredRefreshes.set(key, timer);
  };

  const discoverLiveParents = (): Map<string, number> => {
    const busySubagents = new Map<string, number>();
    const currentDetachedIds = new Set<string>();
    for (const record of deps.sessions.values()) {
      if (
        (record.taskType !== "subagent_child" && record.taskType !== "selection_side_chat") ||
        !record.parentSessionId
      ) {
        continue;
      }
      const parentId = String(record.parentSessionId);
      seenParentIds.add(parentId);
      if (record.taskType === "subagent_child" && isRecordBusy(record)) {
        busySubagents.set(parentId, (busySubagents.get(parentId) ?? 0) + 1);
      }
    }
    for (const child of deps.getDetachedChildren?.() ?? []) {
      if (!child.parentSessionId || !child.sessionId) continue;
      currentDetachedIds.add(child.sessionId);
      seenParentIds.add(child.parentSessionId);
      const taskType = resolveDetachedTaskType(child.sessionId, child.parentSessionId);
      if (taskType === "subagent_child" && child.running) {
        busySubagents.set(
          child.parentSessionId,
          (busySubagents.get(child.parentSessionId) ?? 0) + 1,
        );
      }
    }
    for (const sessionId of detachedTaskTypes.keys()) {
      if (!currentDetachedIds.has(sessionId)) {
        detachedTaskTypes.delete(sessionId);
        detachedTaskTypeRetryAt.delete(sessionId);
      }
    }
    for (const sessionId of detachedTaskTypeRetryAt.keys()) {
      if (!currentDetachedIds.has(sessionId)) detachedTaskTypeRetryAt.delete(sessionId);
    }
    return busySubagents;
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
      const liveSubagents = discoverLiveParents();
      const staleParents = [...seenParentIds].filter((key) => {
        const lastUpdatedAt = updatedAt.get(key);
        return lastUpdatedAt === undefined || now() - lastUpdatedAt > CHILD_SESSION_FACTS_TTL_MS;
      });
      if (staleParents.length > 0) {
        void refresh(staleParents);
      }
      const count = counts.get(sessionId);
      const childList = children.get(sessionId) ?? [];
      const detachedById = new Map(
        (deps.getDetachedChildren?.() ?? []).map((child) => [child.sessionId, child.running]),
      );
      const runningSubagentCount = liveSubagents.get(sessionId) ?? 0;
      const backgroundWorkIds =
        childList.length > 0 ? deps.getBackgroundWorkIds?.(sessionId) : undefined;
      return {
        ...(count?.sideChats ? { sideChatCount: count.sideChats } : {}),
        ...(count?.subagents ? { subagentCount: count.subagents } : {}),
        ...(runningSubagentCount > 0 ? { runningSubagentCount } : {}),
        ...(childList.length > 0
          ? {
              childSessions: childList.map((child) => {
                const childRecord =
                  child.taskType === "subagent_child" ? deps.sessions.get(child.id) : undefined;
                const running =
                  child.taskType === "subagent_child" &&
                  (childRecord !== undefined
                    ? isRecordBusy(childRecord)
                    : (detachedById.get(child.id) ?? false));
                return toWireChildSession(
                  child,
                  running,
                  running ? backgroundWorkIds?.get(child.id) : undefined,
                );
              }),
            }
          : {}),
      };
    },
  };
}
