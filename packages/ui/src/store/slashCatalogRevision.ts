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
import { create } from "zustand";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface SlashCatalogRevisionState {
  revision: number;
}

export const useSlashCatalogRevisionStore = create<SlashCatalogRevisionState>()(() => ({
  revision: 0,
}));

export function readSlashCatalogRevision(): number {
  return useSlashCatalogRevisionStore.getState().revision;
}

/** Drop every cached workspace slash catalog and move the revision (see the module comment). */
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
