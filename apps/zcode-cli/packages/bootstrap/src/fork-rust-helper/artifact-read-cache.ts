import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

export interface ArtifactPayload {
  bytes: Uint8Array;
  mediaType: string;
}

export interface ArtifactReadCacheOptions {
  now?: () => number;
  /** Byte budget of settled entries; defaults to the v4 gateway's binary read cache budget. */
  maxBytes?: number;
  /** Idle lifetime of an entry; defaults to the v4 gateway's binary read cache TTL. */
  ttlMs?: number;
}

interface Entry {
  accessedAt: number;
  /** `null` while the read is in flight: not counted against the budget, never evicted by it or by the TTL. */
  bytes: number | null;
  payload: Promise<ArtifactPayload>;
}

/**
 * Whole artifact versions kept for chunked `workflowRunArtifactRead` calls, with the v4 gateway's
 * rules (`binaryReadCache`): a byte budget over settled entries, least recently read evicted first,
 * idle entries dropped after the TTL. Unlike the gateway it also drops idle entries on a timer: the
 * helper may sit idle for minutes before Rust reclaims it, and the buffers are its largest memory.
 */
export function createArtifactReadCache(options: ArtifactReadCacheOptions = {}) {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes;
  const ttlMs = options.ttlMs ?? PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs;
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes = Math.max(0, totalBytes - (entry.bytes ?? 0));
  }

  function prune(at: number) {
    // A load in flight is not idle, however long the store takes: dropping it would start a second load.
    for (const [key, entry] of entries) {
      if (entry.bytes !== null && at - entry.accessedAt > ttlMs) remove(key);
    }
    if (totalBytes <= maxBytes) return;
    const settled = [...entries.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of settled) {
      remove(key);
      if (totalBytes <= maxBytes) break;
    }
  }

  function scheduleRelease() {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    if (entries.size === 0) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      prune(now());
      scheduleRelease();
    }, ttlMs + 1);
    releaseTimer.unref?.();
  }

  return {
    read(key: string, load: () => Promise<ArtifactPayload>): Promise<ArtifactPayload> {
      const at = now();
      prune(at);
      const cached = entries.get(key);
      if (cached) {
        cached.accessedAt = at;
        scheduleRelease();
        return cached.payload;
      }
      let entry: Entry | undefined;
      const payload = load().then(
        (artifact) => {
          if (entry && entries.get(key) === entry) {
            const settledAt = now();
            // The reader is waiting for this artifact now: count it as read when it settles, not when the load
            // started, or a slow load would be the first entry the budget evicts.
            entry.accessedAt = settledAt;
            entry.bytes = artifact.bytes.byteLength;
            totalBytes += entry.bytes;
            prune(settledAt);
          }
          return artifact;
        },
        (error: unknown) => {
          if (entry && entries.get(key) === entry) remove(key);
          throw error;
        },
      );
      entry = { accessedAt: at, bytes: null, payload };
      entries.set(key, entry);
      scheduleRelease();
      return payload;
    },
    stats() {
      return { entries: entries.size, bytes: totalBytes };
    },
    clear() {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = undefined;
      entries.clear();
      totalBytes = 0;
    },
  };
}
