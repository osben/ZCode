// Compile-level and runtime checks for the API names that packages/ui imports from upstream 3.16.1.
// The type-only imports below fail `pnpm typecheck` if a name stops being exported from the fork entry points.
import { describe, expect, it, vi } from "vitest";
import {
  IPluginManagementService,
  IProjectService,
  IRemoteProjectService,
  ISourceServerManagementService,
  withPluginTelemetry,
  type OnboardingSettingsSyncPatch,
  type ProjectTask,
  type ProjectTree,
  type RemoteProjectDirectory,
  type RemoteProjectHost,
  type UpdateConnectionProfileInput,
  type VirtualProject,
  type WindowHostTaskUnreadSignal,
} from "../src/index.js";
import { createLegacySingleRootProjectService } from "../src/node.js";
import { createPluginManagementService } from "../src/plugins/pluginManagementService.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import type {
  WebRemoteControlMobileTaskView,
  WindowScreenshotResult,
  ZCodeWorkspaceStateSnapshot,
  WorkspaceHookReviewTrustState,
} from "@zcode/shared";
import { isWebRemoteControlBridgeableWorkspaceTarget } from "@zcode/shared";

type Assert<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;

// Type-level checks: each alias must resolve to the real exported shape, not `any`.
export type UpstreamApiTypeChecks = [
  Assert<IsAssignable<VirtualProject["id"], string>>,
  Assert<IsAssignable<ProjectTask["workspacePath"], string>>,
  Assert<IsAssignable<ProjectTree["projects"] extends unknown[] ? true : false, true>>,
  Assert<IsAssignable<RemoteProjectHost["id"], string>>,
  Assert<IsAssignable<RemoteProjectDirectory extends object ? true : false, true>>,
  Assert<IsAssignable<OnboardingSettingsSyncPatch extends object ? true : false, true>>,
  Assert<IsAssignable<UpdateConnectionProfileInput extends object ? true : false, true>>,
  Assert<IsAssignable<WindowHostTaskUnreadSignal["status"], "completed" | "error">>,
  Assert<IsAssignable<WindowScreenshotResult extends object ? true : false, true>>,
  Assert<IsAssignable<WorkspaceHookReviewTrustState, string | object>>,
  Assert<IsAssignable<WebRemoteControlMobileTaskView["taskId"], string>>,
];

describe("upstream 3.16.1 API exports used by packages/ui", () => {
  it("exports the value descriptors and helpers at runtime", () => {
    expect(ISourceServerManagementService).toBeDefined();
    expect(IProjectService).toBeDefined();
    expect(IRemoteProjectService).toBeDefined();
    expect(IPluginManagementService).toBeDefined();
    expect(typeof withPluginTelemetry).toBe("function");
    expect(typeof createLegacySingleRootProjectService).toBe("function");
    expect(typeof isWebRemoteControlBridgeableWorkspaceTarget).toBe("function");
  });

  it("accepts a minimal workspace state snapshot", () => {
    const snapshot: ZCodeWorkspaceStateSnapshot = {
      workspace: {
        workspacePath: "/workspace",
        workspaceKey: "/workspace",
      },
      settings: {
        model: { available: [] },
        thoughtLevel: { enabled: false, available: [] },
        mode: { current: "build" },
      },
    };
    expect(snapshot.workspace.workspaceKey).toBe("/workspace");
  });

  it("classifies a remote target as bridgeable only with identity and runtime session", () => {
    expect(
      isWebRemoteControlBridgeableWorkspaceTarget({
        kind: "local",
        workspacePath: "/local",
      } as never),
    ).toBe(true);
    expect(
      isWebRemoteControlBridgeableWorkspaceTarget({
        kind: "remote",
        workspacePath: "/remote",
      } as never),
    ).toBe(false);
  });
});

describe("withPluginTelemetry", () => {
  const telemetry = {
    entry: "store_detail" as const,
    client_kind: "desktop" as const,
    trigger: "user" as const,
  };

  it("attaches telemetry to plugin mutations but never forwards it to the agent", async () => {
    const installPlugin = vi.fn(async (_params: unknown) => ({ ok: true }));
    const uninstallPlugin = vi.fn(async (_params: unknown) => ({ ok: true }));
    const listPlugins = vi.fn(async () => ({ plugins: [] }));
    const base = createPluginManagementService({
      zcodeAgentService: {
        installPlugin,
        uninstallPlugin,
        listPlugins,
      } as unknown as IZCodeAgentService,
    });
    const service = withPluginTelemetry(base, telemetry);

    await service.installPlugin({
      workspacePath: "/workspace",
      marketplace: "official",
      pluginName: "demo",
    });
    await service.uninstallPlugin({
      workspacePath: "/workspace",
      marketplace: "official",
      pluginName: "demo",
    } as never);

    expect(installPlugin).toHaveBeenCalledTimes(1);
    expect(installPlugin.mock.calls[0]?.[0]).not.toHaveProperty("telemetry");
    expect(installPlugin.mock.calls[0]?.[0]).toMatchObject({
      workspacePath: "/workspace",
      pluginName: "demo",
    });
    expect(uninstallPlugin.mock.calls[0]?.[0]).not.toHaveProperty("telemetry");

    // Non-mutations are bound and passed through unchanged.
    await service.listPlugins({ workspacePath: "/workspace" } as never);
    expect(listPlugins).toHaveBeenCalledWith({ workspacePath: "/workspace" });
  });
});
