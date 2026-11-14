// Fork: the Host acknowledges that it listens for reverse requests (specs/fork-rust-credential-cipher.md F1, B5).
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, zcodeProcessHostAttachedParamsSchema } from "@zcode/shared";

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
  isSharedRuntime() {
    return false;
  }
  getRuntimeWorkspaces(params: unknown) {
    return [params];
  }
  disposeAll() {}
}

async function startService(options: Record<string, unknown>) {
  const events: string[] = [];
  const notify = vi.fn(async (method: string, params: unknown) => {
    events.push(`notify:${method}`);
    return params;
  });
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === zcodeProtocolMethods.initialize) {
        return {
          available: true,
          protocolName: "ZCode Protocol",
          protocolVersion: 1,
          workspaceKey: "/workspace/app",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    }),
    notify,
    respond: vi.fn(async () => {}),
    respondError: vi.fn(async () => {}),
    transportKind: "stdio",
    onNotification: () => ({ dispose() {} }),
    onRequest: () => {
      events.push("onRequest");
      return { dispose() {} };
    },
    onClose: () => ({ dispose() {} }),
  };
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      async getClient() {
        return client;
      }
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    // A ready model selection lets initialize reach the runtime client.
    modelSelectionReadinessSource: {
      async getView() {
        return {
          revision: 1,
          providers: [
            {
              providerId: "account:zai-start-plan",
              config: {
                kind: "api" as const,
                api: { type: "openai-chat-completions" },
                models: ["glm"],
              },
              models: [{ modelId: "glm", config: {} }],
            },
          ],
        };
      },
      onDidChange: () => ({ dispose() {} }),
    },
    ...options,
  });
  await service.initialize({ workspacePath: "/workspace/app" });
  await service.initialize({ workspacePath: "/workspace/app" });
  return { service, notify, events };
}

describe("Host attach acknowledgement", () => {
  it("is sent once per client, after the reverse-request listener is attached", async () => {
    const { service, notify, events } = await startService({
      credentialCipherProvider: {
        encrypt: async () => "",
        decrypt: async () => "",
      },
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const acks = notify.mock.calls.filter(
      ([method]) => method === zcodeProtocolMethods.processHostAttached,
    );
    expect(acks).toHaveLength(1);
    expect(zcodeProcessHostAttachedParamsSchema.parse(acks[0]![1])).toEqual({
      credentialCipher: true,
    });
    expect(events.indexOf("onRequest")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("onRequest")).toBeLessThan(
      events.indexOf(`notify:${zcodeProtocolMethods.processHostAttached}`),
    );
    service.disposeAll();
  });

  it("says when this Host has no credential cipher", async () => {
    const { service, notify } = await startService({});
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(zcodeProtocolMethods.processHostAttached, {
        credentialCipher: false,
      }),
    );
    service.disposeAll();
  });
});

describe("process/hostAttached params", () => {
  it("are strict", () => {
    expect(zcodeProcessHostAttachedParamsSchema.safeParse({ credentialCipher: true }).success).toBe(
      true,
    );
    expect(zcodeProcessHostAttachedParamsSchema.safeParse({}).success).toBe(false);
    expect(
      zcodeProcessHostAttachedParamsSchema.safeParse({
        credentialCipher: true,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
