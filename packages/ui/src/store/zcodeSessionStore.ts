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
  providerStartupSettled: false,
  setProviderStartupSettled: (settled: boolean) => set({ providerStartupSettled: settled }),
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

/**
 * Fork (W9h): a revision for the cached workspace `/` catalogs.
 *
 * The composer caches each workspace's slash catalog in zcodeSessionStore and re-reads
 * `workspace/readPresentation` only when that catalog is empty. Some catalog inputs change without
 * a session event: the user's dynamic-workflow choice (Settings › Agent abilities) decides whether
 * the runtime lists `workflow`, and the Host resends the policy to the runtime, but nothing told
 * the renderer its cached catalog was stale. A new draft kept showing (or hiding) `workflow` after
 * the choice changed (desktop E2E DWG-23, on Node and on zcode-rs).
 *
 * `invalidateSlashCatalogs` drops every cached catalog and moves the revision. The composer's
 * hydration effect reads the revision, so a mounted composer re-reads at once, and a read that
 * started under an older revision is discarded instead of writing the stale catalog back.
 */
interface SlashCatalogRevisionState {
  revision: number;
}

export const useSlashCatalogRevisionStore = create<SlashCatalogRevisionState>()(() => ({
  revision: 0,
}));

export function readSlashCatalogRevision(): number {
  return useSlashCatalogRevisionStore.getState().revision;
}

/** Drop every cached workspace slash catalog and move the revision (see the comment above). */
export function invalidateSlashCatalogs(): void {
  useZCodeSessionStore.setState((state) => {
    const workspaces = Object.fromEntries(
      Object.entries(state.workspaces).map(([key, workspace]) => [
        key,
        workspace.slashCommands.length === 0 ? workspace : { ...workspace, slashCommands: [] },
      ]),
    );
    return { workspaces };
  });
  useSlashCatalogRevisionStore.setState((state) => ({ revision: state.revision + 1 }));
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
