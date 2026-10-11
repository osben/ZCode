/**
 * Public contract for the storage module: re-exports service interfaces and types used by the file explorer's Storage tab.
 * Import only from here; implementation details (Worker, fs, and catalog rules) remain internal to the module.
 */
import type { Event } from "@zcode/rpc";
import type { StorageManagementApi, StorageUsageSnapshot } from "@zcode/shared";

// @zcode/shared is the single source of truth for data types (shared by the renderer bridge and main); re-export them here for use within services.
export type {
  StorageCategoryId,
  StorageCategoryUsage,
  StorageCleanRequest,
  StorageCleanResult,
  StorageCleanability,
  StorageEntryUsage,
  StorageManagementApi,
  StoragePathError,
  StorageRootId,
  StorageRootSpec,
  StorageRootUsage,
  StorageScanStatus,
  StorageUsageSnapshot,
  StorageVolume,
  StorageVolumeGroup,
} from "@zcode/shared";

/**
 * Storage service instance interface. Desktop main currently owns one instance (dedicated to the file explorer window).
 * It is no longer registered as a host RPC service, so it has no ServiceDescriptor or channel.
 */
export interface IStorageService extends StorageManagementApi {
  onScanProgress: Event<StorageUsageSnapshot>;
  /** Cancel an in-progress scan and release its event source. */
  dispose(): void;
}
