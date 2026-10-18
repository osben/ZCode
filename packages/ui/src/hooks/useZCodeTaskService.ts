import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskSnapshot } from "@zcode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IZCodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ZCodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IZCodeTaskService["getTaskSnapshotWithEtag"]>[0];

const zcodeTaskServiceProxyCache = new WeakMap<IZCodeTaskService, IZCodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IZCodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  IZCodeTaskService,
  Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "zcode-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ZCodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// In-memory diagnostic counter: WeakMap cannot be enumerated, so remember the most recent
// service memory cache (in the renderer there is actually only one task-service instance).
let latestSnapshotCache: Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

export function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity?.trim() ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // Desktop continuous and mobile remote replayable snapshots may use different recovery logic.
    // The cache key must distinguish clientMode, or one side may reuse the other side’s snapshot.
    params.clientMode ?? "desktop-continuous",
    // Mobile read-only recovery deliberately skips model backfill from task-index.
    // Different policies mean different host recovery semantics, so they cannot share a snapshot cache.
    params.resumeModelPolicy ?? "task-index",
    // Mobile first-screen recovery uses the historical model hint to activate the session.
    // For the same task, a different model hint may also mean a different context window, so isolate the cache.
    params.model ?? "",
    // Replayable snapshots now include configOptions projected from session settings.
    // A different thoughtLevel for the same model also changes toolbar configuration and subsequent send hints; do not reuse an old snapshot.
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: IZCodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IZCodeTaskService,
): Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

function writePersistedSnapshotEntry(key: string, etag: string, snapshot: ZCodeTaskSnapshot): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // Writing a large-message task snapshot directly to localStorage can quickly hit quota limits and slow the main thread.
    // Persist only small snapshots here, deleting old cache entries when over the limit so loading optimization does not create storage pressure.
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

function createZCodeTaskServiceProxy(service: IZCodeTaskService): IZCodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          snapshotCache.set(requestKey, cachedSnapshotEntry);
        }

        // During first-screen remote-control recovery, multiple hooks may request the same task snapshot concurrently,
        // making the host run getTaskSnapshot repeatedly and send the same oversized snapshot through the relay.
        // Deduplicate concurrent requests by “same service + same parameters,” reusing the same Promise on a match,
        // so only one RPC is sent at a time. Also send if-none-match and reuse the cached local snapshot when unchanged,
        // avoiding repeated transfer of large JSON.
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // If only the etag is persisted and no usable snapshot body exists, do not pass notModified through to the caller,
            // or the first screen receives empty data. Retry once with no if-none-match to prioritize complete data.
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
              };
              snapshotCache.set(requestKey, nextEntry);
              writePersistedSnapshotEntry(requestKey, fallbackResult.etag, fallbackResult.snapshot);
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
            };
            snapshotCache.set(requestKey, nextEntry);
            writePersistedSnapshotEntry(requestKey, firstResult.etag, firstResult.snapshot);
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** Get the ZCode task wrapper service instance. */
export function useZCodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeTaskService {
  // Resolve the ZCode task service by workspace identity so all task RPCs reach the corresponding host.
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.zcodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = zcodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createZCodeTaskServiceProxy(rawService);
  zcodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
