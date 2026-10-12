import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { RelayDeviceStore, RelayRegistration } from "../contract.js";

export async function createRelayDeviceStore(options: {
  path: string;
  storageKey: string;
  maxRecords?: number;
}): Promise<RelayDeviceStore> {
  const bytes = Buffer.from(options.storageKey, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== options.storageKey) {
    throw new Error("Relay storage key must be a canonical base64-encoded 32-byte key.");
  }
  const maxRecords = options.maxRecords ?? 100_000;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1)
    throw new Error("Registration limit must be positive.");
  const path = resolve(options.path);
  await mkdir(dirname(path), { recursive: true });
  // Source tests use Node's TypeScript support; bundles load the adjacent JavaScript worker.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`./deviceStoreWorker.${extension}`, import.meta.url), {
    workerData: { path, storageKey: options.storageKey, maxRecords },
  });
  let nextId = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<
    number,
    { resolve: (result: RelayRegistration | null) => void; reject: (error: Error) => void }
  >();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const exited = new Promise<number>((resolveExit) => worker.once("exit", resolveExit));
  function failPending() {
    readyReject(new Error("Registration store initialization failed."));
    for (const request of pending.values())
      request.reject(new Error("Registration store unavailable."));
    pending.clear();
  }
  worker.on("error", failPending);
  worker.on("exit", () => {
    closing = true;
    failPending();
  });
  worker.on(
    "message",
    (message: {
      type?: string;
      id?: number;
      result?: RelayRegistration | null;
      error?: string;
    }) => {
      if (message.type === "ready") {
        readyResolve();
        return;
      }
      if (message.type === "startup-error") {
        readyReject(new Error("Registration store initialization failed."));
        return;
      }
      const request = message.id === undefined ? undefined : pending.get(message.id);
      if (!request || message.id === undefined) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error("Registration store operation failed."));
      else request.resolve(message.result ?? null);
    },
  );
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }

  function request(
    method: "register" | "get" | "touch" | "close",
    args: Record<string, string> = {},
  ) {
    if (closing && method !== "close")
      return Promise.reject(new Error("Registration store is closed."));
    if (pending.size >= 64)
      return Promise.reject(new Error("Registration store capacity exceeded."));
    return new Promise<RelayRegistration | null>((resolveRequest, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveRequest, reject });
      try {
        worker.postMessage({ id, method, ...args });
      } catch {
        pending.delete(id);
        reject(new Error("Registration worker unavailable."));
      }
    });
  }
  return {
    async register(mid, key) {
      const record = await request("register", { mid, key });
      if (!record) throw new Error("Registration store returned no registration.");
      return record;
    },
    async get(sid) {
      return (await request("get", { sid })) ?? undefined;
    },
    async touch(sid) {
      await request("touch", { sid });
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        try {
          await request("close");
          if ((await exited) !== 0) throw new Error("Registration worker shutdown failed.");
        } catch (error) {
          await worker.terminate();
          throw error;
        }
      })();
      return closePromise;
    },
  };
}
