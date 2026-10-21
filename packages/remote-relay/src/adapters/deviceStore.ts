import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  RelayLimitError,
  type RelayDeviceKeyStore,
  type RelayDeviceRecord,
  type RelayDeviceStore,
  type RelayKeyLookup,
  type RelayUsageRow,
} from "../contract.js";

interface WorkerReply {
  type?: string;
  id?: number;
  result?: unknown;
  error?: string;
}

export interface RelayIdleSweeper {
  /** Deletes `open`-tier keys idle since before `cutoff` (Unix seconds) with their devices. Returns the count. */
  sweepIdleKeys(cutoff: number): Promise<number>;
}

/**
 * SQLite device records behind one worker thread, so blocking database IO never runs on the
 * socket event loop. The worker returns fixed error text only.
 */
export async function createRelayDeviceStore(options: {
  path: string;
  maxRecords?: number;
  /** Cap on `open`-tier enrolled keys; owner keys are bounded by `maxRecords` only. */
  maxEnrolledKeys?: number;
}): Promise<RelayDeviceStore & RelayDeviceKeyStore & RelayIdleSweeper> {
  const maxRecords = options.maxRecords ?? 100_000;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1)
    throw new Error("Device record limit must be positive.");
  const maxEnrolledKeys = options.maxEnrolledKeys ?? 10_000;
  if (!Number.isSafeInteger(maxEnrolledKeys) || maxEnrolledKeys < 1)
    throw new Error("Enrolled key limit must be positive.");
  const path = resolve(options.path);
  await mkdir(dirname(path), { recursive: true });
  // Source tests use Node's TypeScript support; bundles load the adjacent JavaScript worker.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`./deviceStoreWorker.${extension}`, import.meta.url), {
    workerData: { path, maxRecords, maxEnrolledKeys },
  });
  let nextId = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const exited = new Promise<number>((resolveExit) => worker.once("exit", resolveExit));
  function failPending() {
    readyReject(new Error("Device store initialization failed."));
    for (const request of pending.values()) request.reject(new Error("Device store unavailable."));
    pending.clear();
  }
  worker.on("error", failPending);
  worker.on("exit", () => {
    closing = true;
    failPending();
  });
  worker.on("message", (message: WorkerReply) => {
    if (message.type === "ready") {
      readyResolve();
      return;
    }
    if (message.type === "startup-error") {
      readyReject(new Error("Device store initialization failed."));
      return;
    }
    const request = message.id === undefined ? undefined : pending.get(message.id);
    if (!request || message.id === undefined) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("Device store operation failed."));
    else request.resolve(message.result ?? null);
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }

  function call(payload: Record<string, unknown> & { method: string }): Promise<unknown> {
    if (closing && payload.method !== "close")
      return Promise.reject(new Error("Device store is closed."));
    if (pending.size >= 64) return Promise.reject(new Error("Device store capacity exceeded."));
    return new Promise<unknown>((resolveRequest, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject });
      try {
        worker.postMessage({ id, ...payload });
      } catch {
        pending.delete(id);
        reject(new Error("Device store worker unavailable."));
      }
    });
  }

  return {
    async register(userId, deviceMid, createdAt, maxForUser) {
      const record = (await call({
        method: "register",
        userId,
        deviceMid,
        createdAt,
        ...(maxForUser === undefined ? {} : { maxForUser }),
      })) as (RelayDeviceRecord & { limit?: undefined }) | { limit: true } | null;
      if (record && "limit" in record && record.limit) {
        throw new RelayLimitError("Device limit reached.");
      }
      if (!record || "limit" in record) throw new Error("Device store returned no record.");
      return record;
    },
    async lookup(publicKey) {
      return (await call({ method: "keyExists", publicKey })) as RelayKeyLookup;
    },
    async enroll(publicKey, createdAt, tier) {
      await call({ method: "enrollKey", publicKey, createdAt, tier });
    },
    async touch(publicKey, seenAt) {
      await call({ method: "touchKey", publicKey, seenAt });
    },
    async recordUsage(rows: readonly RelayUsageRow[]) {
      await call({ method: "recordUsage", rows });
    },
    async sweepIdleKeys(cutoff) {
      const reply = (await call({ method: "sweepIdle", cutoff })) as {
        removed: number;
      };
      return reply.removed;
    },
    async listForUser(userId) {
      return (await call({ method: "list", userId })) as RelayDeviceRecord[];
    },
    async get(deviceSid) {
      return (
        ((await call({
          method: "get",
          deviceSid,
        })) as RelayDeviceRecord | null) ?? undefined
      );
    },
    async remove(deviceSid) {
      const reply = (await call({ method: "remove", deviceSid })) as {
        removed: boolean;
      };
      return reply.removed;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        try {
          await call({ method: "close" });
          if ((await exited) !== 0) throw new Error("Device store worker shutdown failed.");
        } catch (error) {
          await worker.terminate();
          throw error;
        }
      })();
      return closePromise;
    },
  };
}
