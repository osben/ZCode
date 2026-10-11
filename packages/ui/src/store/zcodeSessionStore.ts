/**
 * Store for ZCode session UI state.
 *
 * Each tab corresponds to one workspace, so chat-related state must also be stored in workspace buckets.
 * This keeps the current task, in-progress draft, and initialization state from leaking across tabs.
 */
import { create } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { type ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";
import { getWorkspaceState } from "./zcodeSessionStoreSelectors.js";
import { createNavigationSlice } from "./zcodeSessionStoreNavigation.js";
import { createTaskSlice } from "./zcodeSessionStoreTaskSlice.js";
import { createWorkspaceSlice } from "./zcodeSessionStoreWorkspaceSlice.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export const useZCodeSessionStore = create<ZCodeSessionStoreState>()((set, get) => ({
  workspaces: {},
  ...createNavigationSlice(set, get),
  ...createWorkspaceSlice(set),
  ...createTaskSlice(set),
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) =>
    getWorkspaceState(get(), workspacePath, workspaceIdentity),
}));

type ZCodeSessionStoreE2EBridge = typeof useZCodeSessionStore;

declare global {
  interface Window {
    __zcodeSessionStoreE2E?: ZCodeSessionStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // WDIO must explicitly enable the E2E diagnostic entry point; do not reuse ZCODE_ENV=test, which would expose a mutable global store in product test environments.
  window.__zcodeSessionStoreE2E = useZCodeSessionStore;
}

// ────────────────────────────────────────────
// Re-exports: keep external imports from `@/store/zcodeSessionStore` working.
// ────────────────────────────────────────────
export * from "./zcodeSessionStoreTypes.js";
export * from "./zcodeSessionStoreSelectors.js";
// Re-export navigation types used externally:
export type {
  TaskNavigationHistory,
  TaskNavEntry,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";

// Memory diagnostic counter: no deletion path exists for workspace buckets across the repository; log this first.
uiMemoryDiagnosticsRegistry.register("sessionStore", () => ({
  workspaces: Object.keys(useZCodeSessionStore.getState().workspaces).length,
}));
