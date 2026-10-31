import type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  isWindowHostControllerFrameGap,
  matchesTaskListMembershipKind,
  type WindowHostControllerCursor,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

/** Host-owned child-conversation facts (spec: sidebar-child-conversation-counts.md §7, §9). */
export type TaskChildSessionFacts = Pick<
  WindowHostControllerTaskRow["meta"],
  "sideChatCount" | "childSessions"
>;

/**
 * The sidebar lists side chats only (§9). Older fork CLIs still send subagent rows and counters;
 * every renderer mapping drops them here so they degrade to the same rendering.
 */
export function sideChatChildSessions(
  childSessions: TaskChildSessionFacts["childSessions"],
): TaskChildSessionFacts["childSessions"] {
  return childSessions?.filter((child) => child.taskType === "selection_side_chat");
}

/** Live sidecars a task row carries on top of persisted task-index facts. */
export interface WindowControllerTaskOverlay {
  address: WindowHostControllerTaskRow["address"];
  activity?: NonNullable<WindowHostControllerTaskRow["activity"]>;
  childFacts?: TaskChildSessionFacts;
}

/** Defined child facts only; undefined when the task has none (plain rows stay byte-identical). */
export function pickTaskChildSessionFacts(
  meta: TaskChildSessionFacts,
): TaskChildSessionFacts | undefined {
  const facts: TaskChildSessionFacts = {
    ...(meta.sideChatCount !== undefined ? { sideChatCount: meta.sideChatCount } : {}),
    ...(meta.childSessions !== undefined
      ? { childSessions: sideChatChildSessions(meta.childSessions) }
      : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

export interface WindowControllerTaskListRegistry {
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  getDirectoryRevision(): number;
  getSourceRevision(): number;
  /** Online rows' live activity and child facts, keyed by task address. */
  readTaskOverlays(): WindowControllerTaskOverlay[];
  list(
    queryKey: string,
    version: WindowControllerTaskListVersion,
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult>;
}

export interface WindowControllerTaskListVersion {
  controllerRevision: number;
  taskListVersionSignature: string;
  /** Only used to invalidate pre-connection caches when the remote session generation changes; not part of workspace identity. */
  workspaceSourceGenerationSignature?: string;
  manualRefreshSerial?: number;
}

const registries = new WeakMap<object, WindowControllerTaskListRegistry>();

function directoryFacts(row: WindowHostControllerTaskRow): string {
  // Activity time, status, and blocking summary also overwrite meta; those changes must not be
  // misread as directory invalidation.
  // Without live activity the full persisted facts stay; the boundaries of first going live and dropping live also refresh.
  const facts = row.activity
    ? Object.fromEntries(
        Object.entries(row.meta).filter(
          ([key]) => key !== "updatedAt" && key !== "status" && key !== "pendingInteraction",
        ),
      )
    : row.meta;
  return JSON.stringify([row.address, row.membership, row.sourceAvailability, facts]);
}

function taskAddressKey(address: WindowHostControllerTaskRow["address"]): string {
  return JSON.stringify([
    address.remoteSessionId ?? "local",
    address.workspaceIdentity?.trim() || address.workspacePath,
    address.taskId,
  ]);
}

function queryContainsWorkspace(
  query: ZCodeTaskListQuery,
  address: WindowHostControllerTaskRow["address"],
): boolean {
  if (query.workspaceScopes === "host") return !address.sourceServerId && !address.remoteSessionId;
  const workspaceKey = address.workspaceIdentity?.trim() || address.workspacePath;
  return query.workspaceScopes.some(
    (scope) => (scope.workspaceIdentity?.trim() || scope.workspacePath) === workspaceKey,
  );
}

function cacheVersionKey(version: WindowControllerTaskListVersion): string {
  // A Controller frame only triggers the hook to re-read; whether a specific query invalidates is
  // decided by delta scope/membership.
  // Putting the global controllerRevision into the cache key would let one timeline live delta
  // miss all pinned/archived queries and re-create multiple Host RPC rounds per frame. The
  // legacy/manual versions keep their forced-refresh semantics.
  return JSON.stringify({
    taskListVersionSignature: version.taskListVersionSignature,
    workspaceSourceGenerationSignature: version.workspaceSourceGenerationSignature,
    manualRefreshSerial: version.manualRefreshSerial,
  });
}

/** One shared observer per Controller proxy; all list hooks consume only its revision. */
export function getWindowControllerTaskListRegistry(
  controller: IWindowControllerService,
): WindowControllerTaskListRegistry {
  const key = controller as object;
  const existing = registries.get(key);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  const cursors = new Map<string, WindowHostControllerCursor>();
  const subscriptionIds = new Set<string>();
  const queryCache = new Map<
    string,
    {
      versionKey: string;
      promise: Promise<WindowHostControllerTaskListResult>;
      query: ZCodeTaskListQuery;
    }
  >();
  const taskRows = new Map<string, WindowHostControllerTaskRow>();
  let revision = 0;
  let directoryRevision = 0;
  let sourceRevision = 0;
  let started = false;
  let generation = 0;
  let notificationScheduled = false;
  let frameDisposable: { dispose(): void } | null = null;

  const notifyOnce = (): void => {
    if (notificationScheduled) return;
    notificationScheduled = true;
    queueMicrotask(() => {
      notificationScheduled = false;
      if (!started) return;
      revision += 1;
      for (const listener of listeners) listener();
    });
  };

  const stop = (): void => {
    if (!started) return;
    started = false;
    generation += 1;
    frameDisposable?.dispose();
    frameDisposable = null;
    cursors.clear();
    queryCache.clear();
    taskRows.clear();
    const ids = Array.from(subscriptionIds);
    subscriptionIds.clear();
    for (const subscriptionId of ids) {
      void controller.unsubscribeControllerV4({ subscriptionId }).catch(() => {});
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const startGeneration = ++generation;
    frameDisposable = controller.onDynamicControllerFrame()((frame: WindowHostControllerFrame) => {
      if (!started || generation !== startGeneration) return;
      const cursor = cursors.get(frame.subscriptionId);
      if (
        cursor &&
        frame.payload.kind !== "snapshot" &&
        isWindowHostControllerFrameGap(cursor, frame)
      ) {
        void controller
          .resyncControllerV4({
            subscriptionId: frame.subscriptionId,
            base: { logEpoch: cursor.logEpoch, seq: cursor.seq },
            forceSnapshot: true,
          })
          .catch((error) =>
            logger.warn("[windowControllerTaskListRegistry] Controller gap resync 失败", error),
          );
        return;
      }
      cursors.set(frame.subscriptionId, {
        subscriptionId: frame.subscriptionId,
        logEpoch: frame.logEpoch,
        seq: frame.toSeq,
      });
      if (frame.topic === CONTROLLER_WORKSPACES_TOPIC) {
        // A source generation change requires re-establishing observation, even when scope and the visible task set are unchanged.
        sourceRevision += 1;
        directoryRevision += 1;
        notifyOnce();
        return;
      }
      const taskFrame = frame as WindowHostControllerTaskFrame;
      if (taskFrame.payload.kind === "snapshot") {
        directoryRevision += 1;
        sourceRevision += 1;
        taskRows.clear();
        for (const row of taskFrame.payload.snapshot.tasks) {
          taskRows.set(taskAddressKey(row.address), row);
        }
        queryCache.clear();
      } else {
        for (const delta of taskFrame.payload.deltas) {
          const address = delta.op === "task.upserted" ? delta.task.address : delta.address;
          const key = taskAddressKey(address);
          const previous = taskRows.get(key);
          const next = delta.op === "task.upserted" ? delta.task : undefined;
          if (!previous || !next || directoryFacts(previous) !== directoryFacts(next)) {
            directoryRevision += 1;
          }
          if (previous && next && previous.sourceAvailability !== next.sourceAvailability) {
            sourceRevision += 1;
          }
          if (next) taskRows.set(key, next);
          else taskRows.delete(key);

          for (const [queryKey, cached] of queryCache) {
            const touchesWorkspace = queryContainsWorkspace(cached.query, address);
            if (!touchesWorkspace) continue;
            // Previously any task delta cleared all queries. Only with the old row in hand can
            // invalidation be precise by before/after membership; without the old row we cannot
            // rule out that it belonged to another kind, so invalidate conservatively for the
            // current workspace to avoid leaving stale items in timeline/active.
            if (
              !previous ||
              cached.query.kind === "all" ||
              matchesTaskListMembershipKind(previous.membership, cached.query.kind) ||
              (next && matchesTaskListMembershipKind(next.membership, cached.query.kind))
            ) {
              queryCache.delete(queryKey);
            }
          }
        }
      }
      // Consecutive task frames within the same JavaScript scheduling tick merge into one renderer revision.
      notifyOnce();
    });
    void Promise.all(
      [CONTROLLER_WORKSPACES_TOPIC, CONTROLLER_TASKS_INDEX_TOPIC].map(async (topic) => {
        const result = await controller.subscribeControllerV4({
          topic,
          visibility: "foreground",
        });
        if (!started || generation !== startGeneration) {
          await controller.unsubscribeControllerV4({
            subscriptionId: result.ack.subscriptionId,
          });
          return;
        }
        subscriptionIds.add(result.ack.subscriptionId);
      }),
    ).catch((error) =>
      logger.warn("[windowControllerTaskListRegistry] Controller subscribe 失败", error),
    );
  };

  const registry: WindowControllerTaskListRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getRevision() {
      return revision;
    },
    getDirectoryRevision() {
      return directoryRevision;
    },
    getSourceRevision() {
      return sourceRevision;
    },
    readTaskOverlays() {
      return Array.from(taskRows.values()).flatMap((row) => {
        if (row.sourceAvailability !== "online") return [];
        const childFacts = pickTaskChildSessionFacts(row.meta);
        if (!row.activity && !childFacts) return [];
        return [
          {
            address: row.address,
            ...(row.activity ? { activity: row.activity } : {}),
            ...(childFacts ? { childFacts } : {}),
          },
        ];
      });
    },
    list(queryKey, version, query) {
      // Unopened workspaces are not in the Controller's source subscription, so its deltas cannot
      // vouch for the global cache.
      // Search reads the Host every time; the hook only subscribes to directory changes — streaming activity does not trigger a full-library search.
      if (query.workspaceScopes === "host") return controller.listTaskList(query);
      const versionKey = cacheVersionKey(version);
      const cached = queryCache.get(queryKey);
      if (cached?.versionKey === versionKey) return cached.promise;
      const promise = controller.listTaskList(query);
      const entry = { versionKey, promise, query };
      queryCache.set(queryKey, entry);
      void promise.catch(() => {
        if (queryCache.get(queryKey) === entry) queryCache.delete(queryKey);
      });
      return promise;
    },
  };
  registries.set(key, registry);
  return registry;
}
