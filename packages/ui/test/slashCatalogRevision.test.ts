// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { useDynamicWorkflowUserModeSync } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  invalidateSlashCatalogs,
  readSlashCatalogRevision,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";

const WORKFLOW: ZCodeSlashCommand = {
  name: "workflow",
  description: "Run a workflow",
  inputHint: "/workflow",
  source: "builtin",
};

function cachedSlashNames(workspacePath: string): string[] {
  return useZCodeSessionStore
    .getState()
    .getWorkspaceState(workspacePath)
    .slashCommands.map((command) => command.name);
}

afterEach(() => {
  cleanup();
});

// Desktop E2E DWG-23 (W9h): the composer caches the workspace `/` catalog and reads it again only
// when it is empty, so a dynamic-workflow choice change must drop that cache.
describe("slash catalog invalidation", () => {
  it("drops every cached workspace catalog and moves the revision", () => {
    useZCodeSessionStore.getState().setSlashCommands("/repo-a", [WORKFLOW]);
    useZCodeSessionStore.getState().setSlashCommands("/repo-b", [WORKFLOW]);
    const before = readSlashCatalogRevision();

    invalidateSlashCatalogs();

    expect(cachedSlashNames("/repo-a")).toEqual([]);
    expect(cachedSlashNames("/repo-b")).toEqual([]);
    expect(readSlashCatalogRevision()).toBe(before + 1);
  });

  it("invalidates the cached catalogs after the user's dynamic-workflow choice changes", async () => {
    useZCodeSessionStore.getState().setSlashCommands("/repo-c", [WORKFLOW]);
    const syncDynamicWorkflowUserMode = vi.fn(async () => undefined);
    const codingPlanSubscriptionService = {
      getDynamicWorkflowClientConfig: vi.fn(async () => ({
        mode: "disabled",
        enabled: false,
        source: "default",
        offeredMode: "alwaysOn",
      })),
    } as never;
    const { rerender } = renderHook(
      ({ userMode }: { userMode: "disabled" | undefined }) =>
        useDynamicWorkflowUserModeSync({
          settingsLoaded: true,
          userMode,
          zcodeAgentService: { syncDynamicWorkflowUserMode },
          codingPlanSubscriptionService,
        }),
      { initialProps: { userMode: undefined } },
    );
    const before = readSlashCatalogRevision();
    expect(cachedSlashNames("/repo-c")).toEqual(["workflow"]);

    rerender({ userMode: "disabled" });

    await waitFor(() => expect(syncDynamicWorkflowUserMode).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cachedSlashNames("/repo-c")).toEqual([]));
    expect(readSlashCatalogRevision()).toBe(before + 1);
  });
});
