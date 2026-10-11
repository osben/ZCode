import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, formatZCodeRendererProcessName } from "@zcode/shared";
import type {
  ResourceUsageSnapshot,
  NetworkCaptureBridge,
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";

process.title = formatZCodeRendererProcessName("Resource Manager");

const storage: StorageManagementBridge = {
  startScan: (): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(PlatformChannels.StorageStartScan),
  cancelScan: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageCancelScan, jobId),
  getSnapshot: (): Promise<StorageUsageSnapshot | null> =>
    ipcRenderer.invoke(PlatformChannels.StorageGetSnapshot),
  clean: (request: StorageCleanRequest): Promise<StorageCleanResult> =>
    ipcRenderer.invoke(PlatformChannels.StorageClean, request),
  revealPath: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageRevealPath, absolutePath),
  subscribeScanProgress: (listener) => {
    const handler = (_event: unknown, snapshot: StorageUsageSnapshot) => listener(snapshot);
    ipcRenderer.on(PlatformChannels.StorageScanProgress, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.StorageScanProgress, handler);
  },
};

const network: NetworkCaptureBridge = {
  getSnapshot: () => ipcRenderer.invoke(PlatformChannels.GetNetworkCaptureSnapshot),
  clear: () => ipcRenderer.invoke(PlatformChannels.ClearNetworkCapture),
};

/**
 * Dedicated preload for the resource manager window, exposing resource snapshot reads and storage
 * management commands.
 * It does not need MessagePort forwarding because the resource manager uses no RPC services and does not
 * join the desktop continuous main channel. Main owns the storage service; this is only an IPC bridge.
 */
contextBridge.exposeInMainWorld("resourceManager", {
  setSamplingActive: (active: boolean): void =>
    ipcRenderer.send(PlatformChannels.SetResourceUsageSamplingActive, active),
  getSnapshot: (): Promise<ResourceUsageSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetResourceUsageSnapshot),
  storage,
  network,
});
