import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildChatGptPlanAccountProviderId,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  requiresRequestVerification,
} from "@zcode/shared";
import type { AccountRequestAuthMaterial } from "../src/model-provider/accountRequestAuthService.js";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

// Account-plan provider runtime headers are answered automatically by the Host, without depending on the Renderer.
const target = {
  workspacePath: "/test/account-auth",
  sessionId: "sess-account-auth",
  requestId: "account-auth-1",
};

async function setup(
  resolveCurrent = vi.fn(
    async (): Promise<AccountRequestAuthMaterial> => ({
      apiKey: "host-key",
      apiKeyId: "host-key-id",
      headers: { Authorization: "Bearer host-only" },
    }),
  ),
  chatGptPlanRequestAuth?: {
    resolve: (input: {
      expectedAccountScope?: string;
      forceRefresh: boolean;
      providerId: string;
    }) => Promise<{ accountScope?: string; apiKey: string }>;
  },
) {
  let receive: ((request: unknown) => void) | undefined;
  let notify: ((message: unknown) => void) | undefined;
  const respond = vi.fn(async () => {});
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      markReady() {}
      disposeAll() {}
      async getClient() {
        return {
          request: vi.fn(),
          respond,
          respondError: vi.fn(),
          transportKind: "stdio",
          onRequest(listener: typeof receive) {
            receive = listener;
            return { dispose() {} };
          },
          onNotification(listener: typeof notify) {
            notify = listener;
            return { dispose() {} };
          },
          onClose() {
            return { dispose() {} };
          },
        };
      }
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => offPeakSelectionView() },
    ...(chatGptPlanRequestAuth ? { chatGptPlanRequestAuth } : {}),
    accountRequestAuthService: {
      resolveCurrent,
      resolveAccessCurrent: async () => null,
      assertCurrent: async () => {},
    },
  });
  await service.initialize(target);
  const workspace = { workspacePath: target.workspacePath, workspaceKey: target.workspacePath };
  const fire = (
    mode: "start-plan" | "individual-coding-plan" | "off-peak" = "start-plan",
    expectedAccountScope?: string,
    rejectedProjectTokenFingerprint?: string,
  ) =>
    receive?.({
      id: "protocol-1",
      method: zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
      params: {
        requestId: target.requestId,
        sessionId: target.sessionId,
        workspace,
        providerId: `account:zai-${mode}`,
        modelSelection: { providerId: `account:zai-${mode}`, modelId: "GLM-5.2" },
        accountAccess: { type: "zhipu-account", accountType: "zai", mode, entitled: true },
        reason: "model-request",
        ...(expectedAccountScope ? { expectedAccountScope } : {}),
        ...(rejectedProjectTokenFingerprint ? { rejectedProjectTokenFingerprint } : {}),
      },
    });
  const chatgptAccountProviderId = buildChatGptPlanAccountProviderId("a1b2c3d4e5f60718");
  const fireChatgpt = (expectedAccountScope?: string, rejectedProjectTokenFingerprint?: string) =>
    receive?.({
      id: "protocol-1",
      method: zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
      params: {
        requestId: target.requestId,
        sessionId: target.sessionId,
        workspace,
        providerId: chatgptAccountProviderId,
        modelSelection: {
          providerId: chatgptAccountProviderId,
          modelId: "gpt-6.1-sol",
        },
        reason: "model-request",
        ...(expectedAccountScope ? { expectedAccountScope } : {}),
        ...(rejectedProjectTokenFingerprint ? { rejectedProjectTokenFingerprint } : {}),
      },
    });
  const cancel = () =>
    notify?.({
      method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
      params: { requestId: target.requestId, sessionId: target.sessionId, workspace },
    });
  return { service, fire, fireChatgpt, cancel, respond, resolveCurrent };
}

describe("Host 自动应答账号请求鉴权", () => {
  it("ChatGPT plan request auth is answered without a renderer interaction", async () => {
    const accountScope = "c".repeat(64);
    const resolve = vi.fn(async () => ({ apiKey: "chatgpt-token", accountScope }));
    const { service, fireChatgpt, respond } = await setup(undefined, { resolve });
    try {
      fireChatgpt();
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith("protocol-1", {
          headersApplied: true,
          requestAuth: { apiKey: "chatgpt-token", accountScope },
        }),
      );
      expect(resolve).toHaveBeenCalledWith({
        expectedAccountScope: undefined,
        forceRefresh: false,
        providerId: buildChatGptPlanAccountProviderId("a1b2c3d4e5f60718"),
      });
    } finally {
      service.disposeAll();
    }
  });

  it("individual-coding-plan：凭据解析期间取消，不回传迟到材料", async () => {
    const deferred = Promise.withResolvers<AccountRequestAuthMaterial>();
    const { service, fire, cancel, respond } = await setup(vi.fn(() => deferred.promise));
    try {
      fire("individual-coding-plan");
      cancel();
      deferred.resolve({ apiKey: "late-key" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(respond).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("闲时 scope 在 Host 私有 owner 校验，无需 Renderer 应答", async () => {
    const accountScope = "a".repeat(64);
    const resolve = vi.fn(async () => ({ apiKey: "fresh-pat", accountScope }));
    const { service, fire, respond } = await setup(resolve);
    try {
      fire("off-peak", accountScope, "b".repeat(64));
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith("protocol-1", {
          headersApplied: true,
          requestAuth: { apiKey: "fresh-pat", accountScope },
        }),
      );
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAccountScope: accountScope,
          rejectedProjectTokenFingerprint: "b".repeat(64),
          accountAccess: expect.objectContaining({ mode: "off-peak" }),
        }),
      );
    } finally {
      service.disposeAll();
    }
  });
});

it("edition policy selects interaction without changing the Host credential owner", async () => {
  const { service, fire, respond, resolveCurrent } = await setup();
  const listener = vi.fn();
  const subscription = service.onDynamicWorkspaceProviderRuntimeHeadersRequest({
    workspacePath: target.workspacePath,
  })(listener);
  try {
    fire("start-plan");
    if (requiresRequestVerification({ mode: "start-plan" })) {
      expect(listener).toHaveBeenCalledOnce();
      expect(resolveCurrent).not.toHaveBeenCalled();
      await service.respondProviderRuntimeHeaders({
        ...target,
        response: { headersApplied: true, runtimeProviderHeaders: {} },
      });
    } else {
      expect(listener).not.toHaveBeenCalled();
    }
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledExactlyOnceWith("protocol-1", {
        headersApplied: true,
        requestAuth: {
          apiKey: "host-key",
          apiKeyId: "host-key-id",
          headers: { Authorization: "Bearer host-only" },
        },
      }),
    );
    expect(resolveCurrent).toHaveBeenCalledOnce();
  } finally {
    subscription.dispose();
    service.disposeAll();
  }
});
