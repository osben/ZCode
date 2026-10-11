/**
 * Storage-scan Worker entry point (worker_threads in the main process).
 * It only runs the services runStorageScan function on a separate thread and sends throttled aggregate snapshots back to main;
 * traversal, classification, and aggregation all come from @zcode/services (a single scan path).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { StorageRootSpec } from "@zcode/services";
import { runStorageScan } from "@zcode/services/node";
import {
  isStorageScanWorkerCommand,
  type StorageScanWorkerData,
  type StorageScanWorkerMessage,
} from "./storageScanWorkerProtocol.js";

const port = parentPort;
if (!isMainThread && port) {
  const data = workerData as StorageScanWorkerData;
  const controller = new AbortController();
  const post = (message: StorageScanWorkerMessage) => port.postMessage(message);
  port.on("message", (message: unknown) => {
    if (isStorageScanWorkerCommand(message) && message.type === "abort") {
      controller.abort();
    }
  });
  void runStorageScan({
    roots: data.roots as StorageRootSpec[],
    signal: controller.signal,
    progressIntervalMs: data.progressIntervalMs,
    onProgress: (progress) => post({ type: "progress", progress }),
  })
    .then((progress) => post({ type: "done", progress }))
    .catch((error: unknown) => {
      const isAbort = error instanceof Error && error.name === "AbortError";
      post({
        type: isAbort ? "aborted" : "error",
        message: error instanceof Error ? error.message : String(error),
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined,
      });
    });
}
