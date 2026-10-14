import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { createBotRemoteWorkspaceService } from "../src/bots/botRemoteWorkspaceBridge.js";

type ParentPortListener = (event: { data: unknown; ports?: unknown[] }) => void;

class ParentPortMock {
  readonly messages: unknown[] = [];
  overrideWebRemoteLinkResult: {
    ok: boolean;
    reason?: "workspace-not-open" | "feature-disabled";
  } | null = null;
  ignoreWebRemoteLinkRequests = false;
  private readonly listeners = new Set<ParentPortListener>();

  postMessage(message: unknown): void {
    this.messages.push(message);
    const payload = message as { type?: string; requestId?: string };
    if (!payload.requestId) {
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest) {
      queueMicrotask(() => {
        this.emit({
          type: HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult,
          requestId: payload.requestId,
          ok: true,
          connected: true,
        });
      });
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceReconnectRequest) {
      queueMicrotask(() => {
        this.emit({
          type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
          requestId: payload.requestId,
          ok: true,
          sessionId: "session-1",
        });
      });
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceWebRemoteLinkRequest) {
      if (!this.ignoreWebRemoteLinkRequests) {
        const override = this.overrideWebRemoteLinkResult;
        queueMicrotask(() => {
          this.emit({
            type: HostMessageTypes.BotRemoteWorkspaceWebRemoteLinkResult,
            requestId: payload.requestId,
            ...(override
              ? override
              : {
                  ok: true,
                  url: "https://relay.example/remote/v4?sid=web-1&hash=h&t=1",
                  sessionId: "web-1",
                }),
          });
        });
      }
      return;
    }

    if (payload.type === HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest) {
      queueMicrotask(() => {
        this.emit(
          {
            type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
            requestId: payload.requestId,
            ok: true,
          },
          [new RuntimePortMock()],
        );
      });
    }
  }

  on(event: "message", listener: ParentPortListener): void {
    if (event === "message") {
      this.listeners.add(listener);
    }
  }

  off(event: "message", listener: ParentPortListener): void {
    if (event === "message") {
      this.listeners.delete(listener);
    }
  }

  emit(data: unknown, ports?: unknown[]): void {
    for (const listener of this.listeners) {
      listener({ data, ports });
    }
  }
}

class RuntimePortMock {
  postMessage(): void {}
  start(): void {}
  close(): void {}
  on(): void {}
  off(): void {}
}

function createBridge(port: ParentPortMock, autoResolutionEnabled = true) {
  const remoteZCodeSessionService = {
    updateProviderRegistry: vi.fn(async () => ({
      workspaceState: {},
      status: "applied",
      providerCount: 0,
    })),
  };
  const remoteZCodeAgentService = {
    syncAppRuntimePreferences: vi.fn(async () => undefined),
  };
  const remoteModelSelectionService = {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [],
    })),
  };
  const bridge = createBotRemoteWorkspaceService({
    parentPort: port,
    settingService: {
      get: vi.fn(async () => ({
        askUserQuestionAutoResolutionEnabled: autoResolutionEnabled,
        lastWorkspaceSession: [
          {
            kind: "remote" as const,
            workspacePath: "/workspace/real",
            workspaceIdentity: "remote:docker:demo:/workspace/link",
            target: {
              kind: "docker" as const,
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected" as const,
          },
        ],
      })),
    } as never,
    credentialService: {
      load: vi.fn(async () => null),
    } as never,
    createRuntimeServicesFromPort: vi.fn(() => ({
      zcodeAgentService: remoteZCodeAgentService,
      zcodeTaskService: {},
      zcodeSessionService: remoteZCodeSessionService,
      modelSelectionService: remoteModelSelectionService,
    })) as never,
  });
  return {
    bridge,
    remoteZCodeAgentService,
    remoteModelSelectionService,
    remoteZCodeSessionService,
  };
}

function runtimePortRequestCount(port: ParentPortMock): number {
  return port.messages.filter(
    (message) =>
      (message as { type?: string }).type ===
      HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
  ).length;
}

describe("createBotRemoteWorkspaceService", () => {
  it("queries main for UI-created remote sessions before reporting disconnected", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);

    await expect(
      bridge.isConnected({
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
      }),
    ).resolves.toBe(true);

    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
        target: {
          kind: "docker",
          container: "demo",
        },
      }),
    );
  });

  it("exposes remote task and model-selection services through one shared runtime port", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await expect(bridge.getZCodeTaskService(target)).resolves.toBeTruthy();
    await expect(bridge.getModelSelectionService(target)).resolves.toBeTruthy();

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
        target: {
          kind: "docker",
          container: "demo",
        },
      }),
    );
  });

  it("validates the remote registry without injecting Desktop provider facts", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteModelSelectionService, remoteZCodeSessionService } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.getZCodeTaskService(target);
    await bridge.getModelSelectionService(target);

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(remoteModelSelectionService.getView).toHaveBeenCalledTimes(1);
    expect(remoteZCodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
  });

  it("applies the app preference before exposing a new remote Bot runtime", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteZCodeAgentService } = createBridge(port, false);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.getZCodeTaskService(target);

    // When settings does not configure modelIoFullRetentionEnabled, it is delivered as disabled by default (=== true → false)
    expect(remoteZCodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
  });

  it("mints a web-remote link for a local workspace without remote identity", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);

    await expect(bridge.mintWebRemoteLink({ workspacePath: "/local/project" })).resolves.toEqual({
      ok: true,
      url: "https://relay.example/remote/v4?sid=web-1&hash=h&t=1",
      sessionId: "web-1",
    });

    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceWebRemoteLinkRequest,
        workspacePath: "/local/project",
      }),
    );
    const request = port.messages.find(
      (message) =>
        (message as { type?: string }).type ===
        HostResponseTypes.BotRemoteWorkspaceWebRemoteLinkRequest,
    ) as Record<string, unknown>;
    expect(request["workspaceIdentity"]).toBeUndefined();
    expect(request["target"]).toBeUndefined();
  });

  it("mints a web-remote link for a remote workspace with the resolved target", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);

    await expect(
      bridge.mintWebRemoteLink({
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
      }),
    ).resolves.toEqual({
      ok: true,
      url: "https://relay.example/remote/v4?sid=web-1&hash=h&t=1",
      sessionId: "web-1",
    });

    expect(port.messages).toContainEqual(
      expect.objectContaining({
        type: HostResponseTypes.BotRemoteWorkspaceWebRemoteLinkRequest,
        workspacePath: "/workspace/link",
        workspaceIdentity: "remote:docker:demo:/workspace/link",
        target: { kind: "docker", container: "demo" },
      }),
    );
  });

  it("fails fast for a remote workspace without stored connection info", async () => {
    const port = new ParentPortMock();
    const { bridge } = createBridge(port);

    const result = await bridge.mintWebRemoteLink({
      workspacePath: "/workspace/unknown",
      workspaceIdentity: "remote:docker:other:/workspace/unknown",
    });

    expect(result.ok).toBe(false);
    expect(port.messages).toHaveLength(0);
  });

  it("propagates the failure reason when main cannot serve the workspace", async () => {
    const port = new ParentPortMock();
    port.overrideWebRemoteLinkResult = {
      ok: false,
      reason: "workspace-not-open" as const,
    };
    const { bridge } = createBridge(port);

    await expect(bridge.mintWebRemoteLink({ workspacePath: "/local/project" })).resolves.toEqual({
      ok: false,
      reason: "workspace-not-open",
    });
  });

  it("times out when main never answers a web-remote link request", async () => {
    vi.useFakeTimers();
    try {
      const port = new ParentPortMock();
      port.ignoreWebRemoteLinkRequests = true;
      const { bridge } = createBridge(port);

      const promise = bridge.mintWebRemoteLink({ workspacePath: "/local/project" });
      const assertion = expect(promise).resolves.toEqual({
        ok: false,
        error: "Web remote control link request timed out.",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs only cached remote Bot runtimes without spawning another runtime", async () => {
    const port = new ParentPortMock();
    const { bridge, remoteZCodeAgentService } = createBridge(port);
    const target = {
      workspacePath: "/workspace/link",
      workspaceIdentity: "remote:docker:demo:/workspace/link",
    };

    await bridge.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
    });
    expect(runtimePortRequestCount(port)).toBe(0);

    await bridge.getZCodeTaskService(target);
    remoteZCodeAgentService.syncAppRuntimePreferences.mockClear();
    await bridge.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: false,
    });

    expect(runtimePortRequestCount(port)).toBe(1);
    expect(remoteZCodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
    });
  });
});
