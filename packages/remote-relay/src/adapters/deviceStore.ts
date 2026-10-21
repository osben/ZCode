import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { RelayDeviceKeyStore, RelayDeviceRecord, RelayDeviceStore } from "../contract.js";

interface WorkerReply {
  type?: string;
  id?: number;
  result?: unknown;
  error?: string;
}

/**
 * SQLite device records behind one worker thread, so blocking database IO never runs on the
 * socket event loop. The worker returns fixed error text only.
 */
export async function createRelayDeviceStore(options: {
  path: string;
  maxRecords?: number;
}): Promise<RelayDeviceStore & RelayDeviceKeyStore> {
  const maxRecords = options.maxRecords ?? 100_000;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1)
    throw new Error("Device record limit must be positive.");
  const path = resolve(options.path);
  await mkdir(dirname(path), { recursive: true });
  // Source tests use Node's TypeScript support; bundles load the adjacent JavaScript worker.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`./deviceStoreWorker.${extension}`, import.meta.url), {
    workerData: { path, maxRecords },
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
    async register(userId, deviceMid, createdAt) {
      const record = (await call({
        method: "register",
        userId,
        deviceMid,
        createdAt,
      })) as RelayDeviceRecord | null;
      if (!record) throw new Error("Device store returned no record.");
      return record;
    },
    async isEnrolled(publicKey) {
      const reply = (await call({ method: "keyExists", publicKey })) as { exists: boolean };
      return reply.exists;
    },
    async enroll(publicKey, createdAt) {
      await call({ method: "enrollKey", publicKey, createdAt });
    },
    async listForUser(userId) {
      return (await call({ method: "list", userId })) as RelayDeviceRecord[];
    },
    async get(deviceSid) {
      return ((await call({ method: "get", deviceSid })) as RelayDeviceRecord | null) ?? undefined;
    },
    async remove(deviceSid) {
      const reply = (await call({ method: "remove", deviceSid })) as { removed: boolean };
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
