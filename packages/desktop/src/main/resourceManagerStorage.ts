/**
 * Main-process wiring for the Resource Manager's Storage tab: main owns the sole StorageService
 * instance (which traverses files in a Worker), exposes commands through IPC invoke, and sends
 * progress snapshots to the requesting Resource Manager window. Closing the window cancels the scan.
 * This belongs in main rather than Window Host because that window intentionally does not use RPC
 * (see preload/resourceManager.ts), and filesystem traversal runs in worker_threads without blocking
 * the main event loop.
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PlatformChannels, type StorageCleanRequest, type StorageRootSpec } from "@zcode/shared";
import {
  createFsStorageCleaner,
  createStorageRootsResolver,
  createStorageService,
  getDataBaseDir,
  type IStorageService,
} from "@zcode/services/node";
import { logger } from "./logger.js";
import { createStorageScanWorkerRunner } from "./storageScanWorkerClient.js";

let service: IStorageService | null = null;
let latestJobId: string | null = null;
let subscriber: WebContents | null = null;
const rootsResolver = createStorageRootsResolver({ getHomeDir: homedir, getDataBaseDir });

function getService(): IStorageService {
  if (service) return service;
  service = createStorageService({
    roots: rootsResolver,
    scanRunner: createStorageScanWorkerRunner(),
    cleaner: createFsStorageCleaner(),
  });
  service.onScanProgress((snapshot) => {
    if (subscriber && !subscriber.isDestroyed()) {
      subscriber.send(PlatformChannels.StorageScanProgress, snapshot);
    }
  });
  return service;
}

/** Only the Resource Manager window may issue storage commands; cancel scans when it closes to avoid background work. */
function bindSubscriber(event: IpcMainInvokeEvent): void {
  if (subscriber === event.sender) return;
  subscriber = event.sender;
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.once("closed", () => {
    if (subscriber !== event.sender) return;
    subscriber = null;
    if (latestJobId && service) {
      void service.cancelScan(latestJobId);
      latestJobId = null;
    }
  });
}

/** Pure function: resolve paths only within a data root so the renderer cannot make the system file manager open an arbitrary path. */
export function isPathInsideStorageRoots(absolutePath: string, roots: StorageRootSpec[]): boolean {
  const target = resolve(absolutePath);
  return roots.some((root) => {
    const back = relative(resolve(root.path), target);
    return back === "" || (!back.startsWith("..") && !isAbsolute(back));
  });
}

export function registerResourceManagerStorageIpc(): void {
  ipcMain.handle(PlatformChannels.StorageStartScan, async (event) => {
    bindSubscriber(event);
    const result = await getService().startScan();
    latestJobId = result.jobId;
    return result;
  });
  ipcMain.handle(PlatformChannels.StorageCancelScan, async (_event, jobId: string) => {
    if (!service) return;
    await service.cancelScan(jobId);
    if (latestJobId === jobId) latestJobId = null;
  });
  ipcMain.handle(PlatformChannels.StorageGetSnapshot, async () =>
    service ? service.getSnapshot() : null,
  );
  ipcMain.handle(PlatformChannels.StorageClean, async (event, request: StorageCleanRequest) => {
    bindSubscriber(event);
    return getService().clean(request);
  });
  ipcMain.handle(PlatformChannels.StorageRevealPath, async (_event, absolutePath: string) => {
    const roots = await rootsResolver.resolveRoots();
    if (typeof absolutePath !== "string" || !isPathInsideStorageRoots(absolutePath, roots)) {
      logger.warn("[resource-manager] refused to reveal path outside storage roots", {
        absolutePath,
      });
      return;
    }
    shell.showItemInFolder(absolutePath);
  });
}
