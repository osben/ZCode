/**
 * App-layer ports: storageService depends only on these interfaces; adapters implement the I/O and the desktop host injects them.
 */
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import type {
  StoragePathError,
  StorageRootSpec,
  StorageRootUsage,
  StorageVolume,
} from "@zcode/shared";

export interface RootsResolverPort {
  resolveRoots(): Promise<StorageRootSpec[]>;
}

export interface StorageScanProgress {
  roots: StorageRootUsage[];
  errors: StoragePathError[];
}

export interface StorageScanRunRequest {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  /** The caller reports at its own pace; throttling is handled by the app-layer job. */
  onProgress: (progress: StorageScanProgress) => void;
}

export interface ScanRunnerPort {
  /** Reject with AbortError (name === "AbortError") when cancelled. */
  run(request: StorageScanRunRequest): Promise<StorageScanProgress>;
}

export interface VolumeProbePort {
  probe(path: string): Promise<StorageVolume | null>;
}

export interface StorageDeleteResult {
  deletedCount: number;
  freedBytes: number;
  failures: StoragePathError[];
}

export interface FsCleanerPort {
  listCandidates(rootPath: string, scopes: StorageCleanScope[]): Promise<StorageCleanCandidate[]>;
  deleteFiles(
    rootPath: string,
    targets: StorageCleanCandidate[],
    options: { keepDirectories: string[] },
  ): Promise<StorageDeleteResult>;
}
