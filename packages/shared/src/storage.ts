/**
 * Shared types for Storage management (the Resource Manager's Storage tab).
 * Data comes from the StorageService held by the main process and is sent through preload `window.resourceManager.storage` to the Resource Manager renderer.
 * The services-layer storage module and UI both reference the types here.
 */
/** The two data roots: .zcode under the user's home directory and .zcode under the configured data storage path. */
export type StorageRootId = "home" | "dataBaseDir";

export const STORAGE_CATEGORY_IDS = [
  "sessionStore",
  "subagentTranscripts",
  "toolOutputs",
  "modelTrajectory",
  "devTraces",
  "logs",
  "backups",
  "exports",
  "runtimes",
  "config",
  "other",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

/** Placeholder path for entries collapsed after exceeding the limit; the UI displays "N other items." */
export const STORAGE_MORE_ENTRIES_PATH = "…";

/** none: no cleanup; safe: clean up directly; confirm: require confirmation. */
export type StorageCleanability = "none" | "safe" | "confirm";

/** Scan input: roots resolved by RootsResolverPort. */
export interface StorageRootSpec {
  id: StorageRootId;
  path: string;
  /** Whether a custom data storage path is enabled; if so, v2 under the home root is treated as an old copy and grouped under "Other." */
  hasCustomDataBaseDir: boolean;
}

export interface StorageVolume {
  /** Stable key for the same physical volume (stat().dev); roots with the same key are combined into one disk card. */
  deviceId: string;
  /** Mount-point path on macOS/Linux, drive root on Windows. */
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  /** Path relative to the root directory. */
  relativePath: string;
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  /** Drill-down details: aggregate one level below the path matched by the rule, sorted by bytes descending, with a count limit. */
  entries: StorageEntryUsage[];
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  /** Null if statfs fails; show usage without showing disk capacity. */
  volume: StorageVolume | null;
  bytes: number;
  fileCount: number;
  categories: StorageCategoryUsage[];
}

export type StorageScanStatus = "scanning" | "complete" | "cancelled" | "failed";

export interface StoragePathError {
  path: string;
  code: string;
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: StorageScanStatus;
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  /** Local errors such as EACCES / ENOENT that do not stop the scan. */
  errors: StoragePathError[];
}

export interface StorageCleanRequest {
  rootId: StorageRootId;
  categoryId: StorageCategoryId;
}

export interface StorageCleanResult {
  freedBytes: number;
  deletedCount: number;
  /** Number of files skipped by protection rules (for example, today's logs or session directories younger than 24 hours). */
  skippedCount: number;
  failures: StoragePathError[];
}

/** Volume view: roots on the same physical volume are grouped together for the disk card. */
export interface StorageVolumeGroup {
  /** volume.deviceId; roots that fail detection are grouped individually, keyed by root path. */
  key: string;
  volume: StorageVolume | null;
  roots: StorageRootUsage[];
  bytes: number;
}

/**
 * Group roots by physical volume: roots with the same deviceId share a group; roots that fail detection get their own group.
 * Pure function; root order within each group matches the input, and groups are sorted by bytes descending.
 */
export function groupStorageRootsByVolume(roots: StorageRootUsage[]): StorageVolumeGroup[] {
  const groups = new Map<string, StorageVolumeGroup>();
  for (const root of roots) {
    const key = root.volume ? `dev:${root.volume.deviceId}` : `path:${root.path}`;
    const group = groups.get(key);
    if (group) {
      group.roots.push(root);
      group.bytes += root.bytes;
      continue;
    }
    groups.set(key, { key, volume: root.volume, roots: [root], bytes: root.bytes });
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Command surface shared by the main-process storage service and renderer bridge. */
export interface StorageManagementApi {
  /** Start a scan; cancel any job already in progress first. */
  startScan(): Promise<{ jobId: string }>;
  /** Cancel the specified job; this is a no-op if it is not the current job. */
  cancelScan(jobId: string): Promise<void>;
  /** Most recent snapshot (in progress or complete), or null if no scan has run. */
  getSnapshot(): Promise<StorageUsageSnapshot | null>;
  /** Clean up by category; the caller is responsible for confirmation. Cancels the current scan first if one is in progress. */
  clean(request: StorageCleanRequest): Promise<StorageCleanResult>;
}

/** Bridge exposed by preload to the Resource Manager renderer: `window.resourceManager.storage`. */
export interface StorageManagementBridge extends StorageManagementApi {
  /** Progress event throttled to at most once every 300 ms; the payload is a full snapshot, including terminal states. Returns an unsubscribe function. */
  subscribeScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  /** Reveal a path in the system file manager (must be inside a data root; validated by main). */
  revealPath(absolutePath: string): Promise<void>;
}
