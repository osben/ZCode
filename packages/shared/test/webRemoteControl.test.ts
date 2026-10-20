import { describe, expect, it } from "vitest";
import { HostMessageTypes } from "../src/channels.js";
import {
  WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS,
  WebRemoteControlCloseCodes,
  buildWebRemoteControlExternalQrUrl,
  matchesWebRemoteControlRoutePath,
  parseWebRemoteControlExternalQrParams,
  resolveWebRemoteControlFailureReasonFromCloseCode,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlRoutePathFromBaseUrl,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlPlatformMethod,
} from "../src/web-remote-control.js";
import {
  hostIncomingMessageSchema,
  parseWebRemoteControlAppPayload,
  webRemoteControlPlatformMethodSchema,
  webRemoteControlTaskTargetSchema,
  webRemoteControlWorkspaceTargetSchema,
} from "../src/validation.js";
import { encodeWebRemoteControlRpcTransportMessage } from "../src/web-remote-control-rpc-transport.js";

describe("webRemoteControlWorkspaceTargetSchema", () => {
  it("accepts disconnected remote workspace presentation state", () => {
    expect(
      webRemoteControlWorkspaceTargetSchema.parse({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        label: "app",
        kind: "remote",
        connectionState: "disconnected",
        lastConnectionError: "ssh connection closed",
      }),
    ).toMatchObject({
      connectionState: "disconnected",
      lastConnectionError: "ssh connection closed",
    });
  });
});

describe("resolveWebRemoteControlWorkspaceKey", () => {
  it("uses workspaceIdentity before workspacePath for isolation keys", () => {
    expect(
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: "/workspace/app",
        workspaceIdentity: "ssh://dev.example.com/workspace/app",
      }),
    ).toBe("ssh://dev.example.com/workspace/app");
  });

  it("falls back to workspacePath when workspaceIdentity is empty", () => {
    expect(
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: "/workspace/app",
        workspaceIdentity: "   ",
      }),
    ).toBe("/workspace/app");
  });
});

describe("external relay QR helpers", () => {
  it("validates the optional authoritative desktop version in bootstrap responses", () => {
    const response = {
      zcode_type: "bootstrap-response",
      requestId: "bootstrap-1",
      success: true,
      result: { windowControlSessionId: "sid-1", workspaces: [], tasks: [] },
    };
    expect(parseWebRemoteControlAppPayload(response)).not.toBeNull();
    const result = { ...response.result, desktopAppVersion: "3.12.2" };
    expect(parseWebRemoteControlAppPayload({ ...response, result })).toMatchObject({ result });
    for (const desktopAppVersion of ["", "   ", 123]) {
      expect(
        parseWebRemoteControlAppPayload({
          ...response,
          result: { ...result, desktopAppVersion },
        }),
      ).toBeNull();
    }
  });
  it("builds a V2 QR URL with routing hints only and no credential or theme params", () => {
    expect(
      buildWebRemoteControlExternalQrUrl({
        baseUrl: "https://zcode.z.ai/remote?hash=old&t=1",
        deviceSid: "sid-1",
        deviceMid: "mid-1",
        deviceName: "MacBook",
        appVersion: "1.5.0",
      }),
    ).toBe("https://zcode.z.ai/remote?sid=sid-1&mid=mid-1&name=MacBook&app_version=1.5.0");
  });

  it("parses V2 routing hints without carrying theme state", () => {
    expect(
      parseWebRemoteControlExternalQrParams(new URLSearchParams("sid=sid-1&mid=mid-1&theme=light")),
    ).toEqual({ deviceSid: "sid-1", deviceMid: "mid-1" });
  });

  it("rejects V1 links that carry the hash or t credential", () => {
    expect(
      parseWebRemoteControlExternalQrParams(
        new URLSearchParams("sid=sid-1&hash=hash&t=1710000000000&mid=mid-1"),
      ),
    ).toBeNull();
    expect(
      parseWebRemoteControlExternalQrParams(new URLSearchParams("sid=sid-1&t=1710000000000")),
    ).toBeNull();
  });
});

describe("resolveWebRemoteControlRoutePathFromBaseUrl", () => {
  it("resolves the v2 QR route from the Vite remote base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/")).toBe("/remote");
  });

  it("resolves the v3 QR route from the Vite remote v3 base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/v3/")).toBe("/remote/v3");
  });

  it("resolves the v4 QR route from the Vite remote v4 base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/v4/")).toBe("/remote/v4");
  });

  it("resolves the test QR route from the Vite remote test base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/__test__/")).toBe(
      "/remote/__test__",
    );
  });

  it("keeps the existing dev QR route when Vite uses the root base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/")).toBe("/remote");
  });
});

describe("matchesWebRemoteControlRoutePath", () => {
  it("accepts the remote route with or without a trailing slash", () => {
    expect(matchesWebRemoteControlRoutePath("/remote", "/remote")).toBe(true);
    expect(matchesWebRemoteControlRoutePath("/remote/", "/remote")).toBe(true);
  });

  it("does not accept nested static asset paths as the app route", () => {
    expect(matchesWebRemoteControlRoutePath("/remote/favicon.ico", "/remote")).toBe(false);
  });
});

describe("resolveWebRemoteControlFailureReasonFromCloseCode", () => {
  it("maps invalid mobile connection close codes", () => {
    expect(
      resolveWebRemoteControlFailureReasonFromCloseCode(
        WebRemoteControlCloseCodes.InvalidMobileConnection,
      ),
    ).toBe("invalid-mobile-connection");
  });
});

describe("resolveWebRemoteControlInitialWorkspaceSelection", () => {
  const workspaces = [
    {
      workspacePath: "/tmp/first",
      label: "first",
      kind: "local" as const,
    },
    {
      workspacePath: "/tmp/second",
      label: "second",
      kind: "local" as const,
    },
  ];

  it("prefers the last mobile view state over the desktop launch task", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        mobileViewState: {
          activeWorkspaceKey: "/tmp/second",
          activeTaskId: "mobile-task",
          updatedAt: 2,
        },
        initialViewState: {
          activeWorkspaceKey: "/tmp/first",
          activeTaskId: "desktop-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/second",
      taskId: "mobile-task",
      canBridge: true,
    });
  });

  it("uses the desktop launch task when the phone has no view state yet", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        initialViewState: {
          activeWorkspaceKey: "/tmp/first",
          activeTaskId: "desktop-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/first",
      taskId: "desktop-task",
      canBridge: true,
    });
  });

  it("falls back to the first workspace when no selected view state is valid", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces,
        initialViewState: {
          activeWorkspaceKey: "/tmp/missing",
          activeTaskId: "missing-task",
          updatedAt: 1,
        },
      }),
    ).toEqual({
      workspaceKey: "/tmp/first",
      canBridge: true,
    });
  });

  it("skips disconnected remote workspaces when choosing the initial bridge", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces: [
          {
            workspacePath: "/remote/app",
            workspaceIdentity: "ssh://dev/remote/app",
            label: "remote",
            kind: "remote",
            connectionState: "disconnected",
          },
          {
            workspacePath: "/local/app",
            label: "local",
            kind: "local",
          },
        ],
        mobileViewState: {
          activeWorkspaceKey: "ssh://dev/remote/app",
          activeTaskId: "remote-task",
          updatedAt: 2,
        },
      }),
    ).toEqual({
      workspaceKey: "/local/app",
      canBridge: true,
    });
  });

  it("returns a disconnected remote workspace for home-only mobile reconnect when no bridge target exists", () => {
    expect(
      resolveWebRemoteControlInitialWorkspaceSelection({
        workspaces: [
          {
            workspacePath: "/remote/app",
            workspaceIdentity: "ssh://dev/remote/app",
            label: "remote",
            kind: "remote",
            connectionState: "disconnected",
          },
        ],
        mobileViewState: {
          activeWorkspaceKey: "ssh://dev/remote/app",
          activeTaskId: "remote-task",
          updatedAt: 2,
        },
      }),
    ).toEqual({
      workspaceKey: "ssh://dev/remote/app",
      taskId: "remote-task",
      canBridge: false,
    });
  });
});

describe("webRemoteControlTaskTargetSchema", () => {
  it("accepts optional mobile display status", () => {
    expect(
      webRemoteControlTaskTargetSchema.parse({
        taskId: "task-status",
        title: "Task status",
        workspacePath: "/workspace/app",
        workspaceLabel: "App",
        workspaceKind: "local",
        createdAt: 1,
        updatedAt: 2,
        displayStatus: "running",
      }).displayStatus,
    ).toBe("running");
  });
});

describe("parseWebRemoteControlAppPayload", () => {
  it("accepts pushed workspace list updates", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-list-updated",
        result: {
          workspaces: [
            {
              workspacePath: "/workspace/app",
              label: "app",
              kind: "local",
            },
          ],
          tasks: [
            {
              taskId: "task-1",
              title: "Task one",
              workspacePath: "/workspace/app",
              workspaceLabel: "app",
              workspaceKind: "local",
              createdAt: 1,
              updatedAt: 2,
              displayStatus: "idle",
              archived: true,
            },
          ],
        },
      }),
    ).toMatchObject({
      zcode_type: "workspace-list-updated",
      result: {
        tasks: [expect.objectContaining({ taskId: "task-1", archived: true })],
      },
    });
  });

  it("accepts workspace reconnect requests and responses", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-reconnect-request",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:dev:/workspace/app",
      }),
    ).toMatchObject({
      zcode_type: "workspace-reconnect-request",
      workspaceKey: "remote:ssh:dev:/workspace/app",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-reconnect-response",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:dev:/workspace/app",
        success: true,
      }),
    ).toMatchObject({
      zcode_type: "workspace-reconnect-response",
      success: true,
    });
  });

  it("accepts workspace open requests and responses with optional identity", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-request",
        requestId: "open-1",
        workspacePath: "/workspace/demo-worktrees/feature",
      }),
    ).toMatchObject({
      zcode_type: "workspace-open-request",
      requestId: "open-1",
      workspacePath: "/workspace/demo-worktrees/feature",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-request",
        requestId: "open-2",
        workspacePath: "/workspace/demo-worktrees/feature",
        workspaceIdentity: "remote:ssh:dev:/workspace/demo-worktrees/feature",
      }),
    ).toMatchObject({
      zcode_type: "workspace-open-request",
      workspaceIdentity: "remote:ssh:dev:/workspace/demo-worktrees/feature",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-response",
        requestId: "open-1",
        workspacePath: "/workspace/demo-worktrees/feature",
        success: true,
      }),
    ).toMatchObject({
      zcode_type: "workspace-open-response",
      success: true,
    });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-response",
        requestId: "open-3",
        workspacePath: "/workspace/demo-worktrees/feature",
        workspaceIdentity: "remote:ssh:dev:/workspace/demo-worktrees/feature",
        success: false,
        error: "Desktop window is not available",
      }),
    ).toMatchObject({
      zcode_type: "workspace-open-response",
      success: false,
      error: "Desktop window is not available",
    });
  });

  it("rejects workspace open payloads with an empty or missing workspace path", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-request",
        requestId: "open-1",
        workspacePath: "",
      }),
    ).toBeNull();

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-request",
        requestId: "open-1",
      }),
    ).toBeNull();

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-open-response",
        requestId: "open-1",
        workspacePath: "/workspace/demo-worktrees/feature",
        success: false,
      }),
    ).toBeNull();
  });

  it("preserves mobile device info on mobile view state updates", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-view-state-update",
        viewState: {
          activeWorkspaceKey: "/workspace/app",
          activeTaskId: "task-1",
          updatedAt: 1,
        },
        deviceInfo: {
          platform: "web",
          version: "1.7.0",
          name: "mobile-browser",
          userAgent: "Mozilla/5.0 Mobile Safari/604.1",
          language: "zh-CN",
          languages: ["zh-CN", "en-US"],
          browserPlatform: "iPhone",
          viewport: {
            width: 390,
            height: 844,
            devicePixelRatio: 3,
          },
          screen: {
            width: 390,
            height: 844,
          },
          timezone: "Asia/Shanghai",
          online: true,
          updatedAt: 2,
        },
      }),
    ).toMatchObject({
      zcode_type: "mobile-view-state-update",
      deviceInfo: {
        platform: "web",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        viewport: {
          width: 390,
          height: 844,
        },
      },
    });
  });

  it("removes the legacy one-shot rpc-frame branch from the production app parser", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        seq: 1,
        dataBase64: "AQID",
      }),
    ).toBeNull();
  });

  it("accepts strict acknowledged rpc fragments and cumulative ACKs in the production app parser", () => {
    const [fragment] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    expect(parseWebRemoteControlAppPayload(fragment)).toEqual(fragment);
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "rpc-frame-ack",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        ackMessageSeq: 1,
      }),
    ).toEqual({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      ackMessageSeq: 1,
    });
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        seq: 1,
        dataBase64: "AQID",
        fragmentCount: 1,
      }),
    ).toBeNull();
  });

  it("bounds rpc-frame transport ids so the physical envelope meter is authoritative", () => {
    // The generator uses prefix + UUID / Date / Math.random, producing only this set of JSON-safe ASCII.
    // Every legal character is single-byte and needs no JSON escaping; `~` covers the character-set boundary.
    const boundary = "~".repeat(256);
    const [boundaryFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: boundary,
      recoveryId: boundary,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      firstPhysicalSeq: Number.MAX_SAFE_INTEGER,
      messageSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(parseWebRemoteControlAppPayload(boundaryFrame)).toEqual(boundaryFrame);
    expect(
      parseWebRemoteControlAppPayload({
        ...boundaryFrame,
        bridgeSessionId: `${boundary}x`,
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...boundaryFrame,
        recoveryId: `${boundary}x`,
      }),
    ).toBeNull();
    for (const invalid of ['"', "\\", "\n", "中", "🙂"]) {
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          bridgeSessionId: `bridge-${invalid}-id`,
        }),
      ).toBeNull();
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          recoveryId: `recovery-${invalid}-id`,
        }),
      ).toBeNull();
    }
    for (const key of ["bridgeGeneration", "seq", "messageSeq"] as const) {
      expect(
        parseWebRemoteControlAppPayload({
          ...boundaryFrame,
          [key]: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toBeNull();
    }
  });

  it("accepts bridge degraded recovery payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        reason: "buffer-timeout",
        droppedCount: 1,
      }),
    ).toMatchObject({
      zcode_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      reason: "buffer-timeout",
      droppedCount: 1,
    });
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        reason: "rpc-transport-fault",
      }),
    ).toMatchObject({
      zcode_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      reason: "rpc-transport-fault",
    });
    // Compatibility with the finer-grained enums that older desktops may still send during the atomic upgrade window.
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "bridge-degraded",
        bridgeSessionId: "bridge-legacy",
        reason: "rpc-frame-gap",
      }),
    ).not.toBeNull();
  });

  it("preserves bridge metadata on workspace bridge payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-bridge-open",
        requestId: "bridge-open-1",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        workspaceKey: "/workspace/app",
        taskId: "task-1",
      }),
    ).toMatchObject({
      zcode_type: "workspace-bridge-open",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
    });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "workspace-bridge-ready",
        requestId: "bridge-open-1",
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
        bridge: {
          bridgeSessionId: "bridge-1",
          bridgeGeneration: 2,
          recoveryId: "recovery-1",
          kind: "local",
          workspaceKey: "/workspace/app",
          workspacePath: "/workspace/app",
        },
      }),
    ).toMatchObject({
      zcode_type: "workspace-bridge-ready",
      bridgeGeneration: 2,
      recoveryId: "recovery-1",
      bridge: {
        bridgeGeneration: 2,
        recoveryId: "recovery-1",
      },
    });
  });

  it("accepts low-frequency mobile diagnostic payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-diagnostic",
        event: "pair-status",
        timestamp: 1710000000000,
        state: "paired",
        pairStatus: "waiting",
        visibilityState: "visible",
        online: true,
      }),
    ).toMatchObject({
      zcode_type: "mobile-diagnostic",
      event: "pair-status",
      pairStatus: "waiting",
    });
  });

  it("rejects pair status values that are not emitted by the external relay", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-diagnostic",
        event: "pair-status",
        timestamp: 1710000000000,
        state: "paired",
        pairStatus: "rejected",
      }),
    ).toBeNull();
  });

  it("rejects invalid rpc-frame payloads", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        seq: -1,
        dataBase64: "AQID",
      }),
    ).toBeNull();
  });

  it("accepts open-on-desktop platform requests and responses", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-request",
        requestId: "open-1",
        method: "openInEditor",
        args: {
          editorId: "vscode",
          path: "/workspace/app/src/index.ts",
          options: { pathKind: "file" },
        },
      }),
    ).toMatchObject({ zcode_type: "platform-request", method: "openInEditor" });

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-request",
        requestId: "open-2",
        method: "openInFileManager",
        args: "/workspace/app",
      }),
    ).not.toBeNull();

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-request",
        requestId: "open-3",
        method: "openExternalFile",
        args: "/workspace/app/report.pdf",
      }),
    ).not.toBeNull();

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-request",
        requestId: "open-4",
        method: "getInstalledEditors",
      }),
    ).not.toBeNull();

    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-response",
        requestId: "open-1",
        method: "openInEditor",
        success: true,
        result: { success: true },
      }),
    ).toMatchObject({ method: "openInEditor", success: true, result: { success: true } });
  });

  it("rejects platform requests whose method is not in the proxied allow-list", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "platform-request",
        requestId: "open-5",
        method: "executeDesktopCommand",
        args: "quit",
      }),
    ).toBeNull();
  });
});

// Parity fixture for the relay platform-method allow-list. `Record<..., true>` forces every
// WebRemoteControlPlatformMethod (keyof WebRemoteControlPlatformMethodResultMap) to appear here,
// `satisfies` rejects stray entries, and the runtime test below then requires the zod enum to
// accept exactly this set — a method added to the typed map without the enum (as happened to
// createTempTextAttachment in aac47556) fails here instead of being dropped by the transports.
const allWebRemoteControlPlatformMethods = {
  isDockerAvailable: true,
  listWSLDistros: true,
  listDockerContainers: true,
  listSSHConfigAliases: true,
  createTempTextAttachment: true,
  loadMcpFromUserDirectory: true,
  saveMcpToUserDirectory: true,
  migrateLegacyCommonMcp: true,
  getInstalledEditors: true,
  openInEditor: true,
  openInFileManager: true,
  openExternalFile: true,
} satisfies Record<WebRemoteControlPlatformMethod, true>;

describe("webRemoteControlPlatformMethodSchema", () => {
  it("stays in parity with WebRemoteControlPlatformMethodResultMap", () => {
    const mapKeys = Object.keys(allWebRemoteControlPlatformMethods);
    expect([...webRemoteControlPlatformMethodSchema.options].sort()).toEqual([...mapKeys].sort());
    for (const method of mapKeys) {
      expect(webRemoteControlPlatformMethodSchema.safeParse(method).success).toBe(true);
    }
  });
});

describe("hostIncomingMessageSchema", () => {
  it("accepts attach service port host messages", () => {
    expect(
      hostIncomingMessageSchema.parse({
        type: HostMessageTypes.AttachServicePort,
        requestId: "request-1",
        attachmentId: "attachment-1",
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      }),
    ).toEqual({
      type: HostMessageTypes.AttachServicePort,
      requestId: "request-1",
      attachmentId: "attachment-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    });
  });

  it("accepts explicit service port detach messages", () => {
    expect(
      hostIncomingMessageSchema.parse({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: "attachment-1",
      }),
    ).toEqual({
      type: HostMessageTypes.DetachServicePort,
      attachmentId: "attachment-1",
    });
  });
});

describe("WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS", () => {
  it("documents the shared external relay HMAC vectors", () => {
    const passHash = "dGVzdF9oYXNo";
    const nonce = "nonce-1";
    const deviceSid = "device-1";

    expect(WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS).toEqual([
      {
        passHash,
        nonce,
        role: "device",
        deviceSid,
        proof: "XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE",
      },
      {
        passHash,
        nonce,
        role: "terminal",
        deviceSid,
        proof: "YkqkJy-p-iZK1g1AcoGd0Q83REOggX1EygWkcxW4oLU",
      },
    ]);
  });
});
