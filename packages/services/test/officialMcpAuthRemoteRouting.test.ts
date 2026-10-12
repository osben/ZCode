/* OMCP-011 — official MCP identity-header reverse-request routing for desktop-attached remotes (spec §7.2 / §7.4).
 *
 * Verification goals:
 *   1. Requests from a remote workspace (non-empty workspaceIdentity) are automatically resolved and answered by the host;
 *   2. Responses go back only to **the Agent client that issued the request**, never crossing to another workspace with
 *      the same workspacePath;
 *   3. The request produces no renderer event (no UI semantics) and writes no session/runtime state;
 *   4. Without a resolver (e.g. standalone CLI), it returns official_auth_unavailable and never degrades to an anonymous request.
 *
 * Note: credentials themselves are host-global state, not isolated per workspace (§7.1), so what is asserted here is
 * **routing** and the **response channel**, not per-workspace different credentials.
 */
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";

const LOCAL_WORKSPACE = {
  workspaceKey: "/workspace/app",
  workspacePath: "/workspace/app",
};
const REMOTE_WORKSPACE = {
  workspaceIdentity: "remote:wsl:ubuntu:/workspace/app",
  workspaceKey: "remote:wsl:ubuntu:/workspace/app",
  // Same path as LOCAL: an implementation routing by workspacePath would cross wires — exactly what this case blocks.
  workspacePath: "/workspace/app",
};

interface FakeClient {
  onRequestListener?: (request: unknown) => void;
  respond: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
}

/** Fake client pooled by workspaceKey, simulating the local host and desktop-attached remote host links. */
async function createServiceWithClients(options: {
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(
      request?: unknown,
    ): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /** Defaults to "trust everything" so existing routing cases can focus on the response channel. */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** Omits the validator for real (simulating a wiring miss); `undefined` falls back to the "trust everything" default and cannot express this scenario. */
  omitTrustedOrigins?: boolean;
}): Promise<{
  clients: Map<string, FakeClient>;
  dispose: () => Promise<void>;
  initializeWorkspace: (workspace: {
    workspaceIdentity?: string;
    workspacePath: string;
  }) => Promise<void>;
}> {
  const clients = new Map<string, FakeClient>();

  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      async getClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const key = params.workspaceIdentity ?? params.workspacePath;
        const existing = clients.get(key);
        if (existing) return toProtocolClient(existing);
        const record: FakeClient = {
          respond: vi.fn(async () => {}),
          respondError: vi.fn(async () => {}),
        };
        clients.set(key, record);
        return toProtocolClient(record);
      }
      getExistingClient(params: { workspaceIdentity?: string; workspacePath: string }) {
        const record = clients.get(params.workspaceIdentity ?? params.workspacePath);
        return record ? toProtocolClient(record) : undefined;
      }
      getRuntimeIdentity() {
        return undefined;
      }
      markReady() {}
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      disposeWorkspace() {}
      disposeAll() {}
      async disposeAllAndWait() {}
    },
  }));

  function toProtocolClient(record: FakeClient) {
    return {
      onClose: () => ({ dispose() {} }),
      onNotification: () => ({ dispose() {} }),
      onRequest: (listener: (request: unknown) => void) => {
        record.onRequestListener = listener;
        return { dispose() {} };
      },
      request: async (method: string) => {
        if (method === zcodeProtocolMethods.initialize) {
          return {
            available: true,
            protocolName: "ZCode Protocol",
            protocolVersion: 1,
            workspaceKey: "/workspace/app",
          };
        }
        throw new Error(`Unexpected request method: ${method}`);
      },
      respond: record.respond,
      respondError: record.respondError,
      transportKind: "stdio",
    };
  }

  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    // initialize first confirms an executable model exists in the current model selection View; otherwise it returns
    // early with provider_not_ready without creating a client.
    modelSelectionReadinessSource: {
      async getView() {
        return {
          providers: [
            {
              providerId: "account:zai-start-plan",
              config: {
                kind: "account" as const,
                api: {
                  type: "anthropic-messages" as const,
                  baseUrl: "https://zcode.z.ai/api/v1/zcode-plan",
                },
                models: ["GLM-5.2"],
              },
              models: [{ modelId: "GLM-5.2", config: {} }],
            },
          ],
          revision: 1,
        };
      },
    },
    ...(options.officialMcpAuthHeadersResolver
      ? { officialMcpAuthHeadersResolver: options.officialMcpAuthHeadersResolver }
      : {}),
    ...(options.omitTrustedOrigins
      ? {}
      : {
          officialMcpTrustedOrigins: options.officialMcpTrustedOrigins ?? {
            isTrusted: async () => ({ trusted: true }),
          },
        }),
  });

  return {
    clients,
    dispose: () => service.disposeAllAndWait(),
    initializeWorkspace: async (workspace) => {
      const result = await service.initialize(workspace);
      if (!result.available) {
        throw new Error(`agent initialize failed: ${result.reason ?? "unknown"}`);
      }
    },
  };
}

function officialMcpAuthRequest(
  id: string,
  workspace: Record<string, string>,
): Record<string, unknown> {
  return {
    id,
    method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
    params: {
      mcpKey: "image-search",
      pluginId: "zcode-tools@zcode-plugins-official",
      requestId: `official-mcp-auth:${id}`,
      targetOrigin: "https://mcp.zcode.example",
      workspace,
    },
  };
}

describe("official mcp auth headers over desktop-attached remote", () => {
  it("OMCP-011: answers a remote agent on its own client, not the same-path local one", async () => {
    const headers = {
      Authorization: "Bearer remote-jwt",
      "Bigmodel-Target-Type": "PERSONAL",
      "X-Bigmodel-Authorization": "Bearer remote-maas-jwt",
    };
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers, ok: true }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      // Same workspacePath with different workspaceIdentity must be two independent clients
      expect(harness.clients.size).toBe(2);

      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);
      expect(remote).toBeDefined();
      expect(local).toBeDefined();

      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", { headers, ok: true });
      // Key point: the same-path local client must receive nothing
      expect(local?.respond).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("keeps local and remote responses on separate channels under interleaved requests", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({
          headers: { Authorization: "Bearer shared-jwt" },
          ok: true,
        }),
      },
    });

    try {
      await harness.initializeWorkspace(LOCAL_WORKSPACE);
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const local = harness.clients.get(LOCAL_WORKSPACE.workspacePath);

      local?.onRequestListener?.(officialMcpAuthRequest("local-1", LOCAL_WORKSPACE));
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      local?.onRequestListener?.(officialMcpAuthRequest("local-2", LOCAL_WORKSPACE));

      await vi.waitFor(() => {
        expect(local?.respond).toHaveBeenCalledTimes(2);
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // Every response must return to its own request id; no crossing
      expect(local?.respond.mock.calls.map((call) => call[0])).toEqual(["local-1", "local-2"]);
      expect(remote?.respond.mock.calls.map((call) => call[0])).toEqual(["remote-1"]);
    } finally {
      await harness.dispose();
    }
  });

  it("propagates a plan-required refusal to the remote agent unchanged", async () => {
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ ok: false, reason: "official_auth_plan_required" }),
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_plan_required",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("OMCP-009: reports official_auth_unavailable when no resolver is wired", async () => {
    const harness = await createServiceWithClients({});
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      // Never degrade to anonymous: without a resolver it is explicitly unavailable
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_auth_unavailable",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: rejects an untrusted origin without invoking the resolver at all", async () => {
    // The host is the identity-authority boundary: on an Origin mismatch it must reject **before reading credentials**,
    // or the agent adapter's fetch wrapper becomes the only line of defense (bypassable by a remote runtime).
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      officialMcpTrustedOrigins: { isTrusted: async () => ({ trusted: false }) },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));

      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).toHaveBeenCalledWith("remote-1", {
        ok: false,
        reason: "official_mcp_origin_untrusted",
      });
      // The response must not contain any headers field
      const payload = remote?.respond.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload["headers"]).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain("must-not-leak");
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: fails closed when no trusted-origin validator is injected", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer must-not-leak" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
      omitTrustedOrigins: true,
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: validates all three dimensions, not just one", async () => {
    // Each dimension is wrong in exactly one item and correct otherwise — prevents an implementation that only compares one of them.
    const seen: Array<{ mcpKey: string; origin: string; pluginId: string }> = [];
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: {
        resolveHeaders: async () => ({ headers: { Authorization: "Bearer ok" }, ok: true }),
      },
      officialMcpTrustedOrigins: {
        isTrusted: async (input) => {
          seen.push(input);
          return {
            trusted:
              input.pluginId === "zcode-tools@zcode-plugins-official" &&
              input.mcpKey === "image-search" &&
              input.origin === "https://mcp.zcode.example",
          };
        },
      },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      const variants: Array<{ id: string; overrides: Record<string, string> }> = [
        { id: "bad-plugin", overrides: { pluginId: "evil@third-party" } },
        { id: "bad-key", overrides: { mcpKey: "unregistered" } },
        { id: "bad-origin", overrides: { targetOrigin: "https://attacker.example" } },
      ];
      for (const variant of variants) {
        const base = officialMcpAuthRequest(variant.id, REMOTE_WORKSPACE);
        const params = base["params"] as Record<string, unknown>;
        remote?.onRequestListener?.({
          ...base,
          params: { ...params, ...variant.overrides },
        });
      }
      await vi.waitFor(() => {
        expect(remote?.respond).toHaveBeenCalledTimes(3);
      });
      for (const call of remote?.respond.mock.calls ?? []) {
        expect(call[1]).toEqual({ ok: false, reason: "official_mcp_origin_untrusted" });
      }
      // The validator received all three fields. origin is the only decision basis; pluginId / mcpKey only serve logging
      // and credential-attribution, but must still reach the host in full — otherwise logs cannot answer "which plugin asked for credentials".
      expect(seen).toHaveLength(3);
      expect(seen.every((input) => input.pluginId && input.mcpKey && input.origin)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("CR-01: forwards the request context to the resolver once trusted", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer ok" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });
    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.(officialMcpAuthRequest("remote-1", REMOTE_WORKSPACE));
      await vi.waitFor(() => {
        expect(resolveHeaders).toHaveBeenCalledTimes(1);
      });
      expect(resolveHeaders).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          targetOrigin: "https://mcp.zcode.example",
          workspace: expect.objectContaining({
            workspaceIdentity: REMOTE_WORKSPACE.workspaceIdentity,
          }),
        }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects malformed params without invoking the resolver", async () => {
    const resolveHeaders = vi.fn(async () => ({
      headers: { Authorization: "Bearer jwt" },
      ok: true as const,
    }));
    const harness = await createServiceWithClients({
      officialMcpAuthHeadersResolver: { resolveHeaders },
    });

    try {
      await harness.initializeWorkspace(REMOTE_WORKSPACE);
      const remote = harness.clients.get(REMOTE_WORKSPACE.workspaceIdentity);
      remote?.onRequestListener?.({
        id: "remote-bad",
        method: zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
        // Smuggled credential fields + missing targetOrigin: the strict schema must reject
        params: {
          jwt: "leaked",
          mcpKey: "image-search",
          pluginId: "zcode-tools@zcode-plugins-official",
          requestId: "official-mcp-auth:bad",
          workspace: REMOTE_WORKSPACE,
        },
      });

      await vi.waitFor(() => {
        expect(remote?.respondError).toHaveBeenCalledTimes(1);
      });
      // Schema failure goes through respondError rather than respond, and credential resolution must not be triggered
      expect(resolveHeaders).not.toHaveBeenCalled();
      expect(remote?.respond).not.toHaveBeenCalled();
      expect(remote?.respondError).toHaveBeenCalledWith(
        "remote-bad",
        expect.objectContaining({ code: -32602 }),
      );
    } finally {
      await harness.dispose();
    }
  });
});
