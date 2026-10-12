import type { IStorageService, StorageUsageSnapshot } from "./contract.js";

/**
 * Contract usage example: subscribe to progress and start a scan when entering a section, cancel on leave; rescan after cleanup.
 * This is the minimal skeleton of a UI hook with no implementation details.
 */
export async function useStorageSection(
  storage: IStorageService,
  render: (snapshot: StorageUsageSnapshot) => void,
): Promise<{ leave: () => Promise<void>; cleanTrajectories: () => Promise<void> }> {
  let currentJobId: string | null = null;
  const subscription = storage.onScanProgress((snapshot) => {
    // Consume only the current job's snapshots; late packets from old jobs are dropped.
    if (snapshot.jobId === currentJobId) render(snapshot);
  });
  const start = async () => {
    currentJobId = (await storage.startScan()).jobId;
  };
  await start();
  return {
    leave: async () => {
      subscription.dispose();
      if (currentJobId) await storage.cancelScan(currentJobId);
    },
    cleanTrajectories: async () => {
      await storage.clean({ rootId: "home", categoryId: "modelTrajectory" });
      await start();
    },
  };
}
