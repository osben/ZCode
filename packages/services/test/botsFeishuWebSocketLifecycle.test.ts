import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "@zcode/shared";

const wsState = vi.hoisted(() => ({
  constructorParams: null as Record<string, unknown> | null,
  start: vi.fn(),
  close: vi.fn(),
  readyState: null as number | null,
  isConnecting: false,
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: {
    Feishu: "https://open.feishu.cn",
    Lark: "https://open.larksuite.com",
  },
  LoggerLevel: { info: "info" },
  EventDispatcher: class {
    register() {}
  },
  WSClient: class {
    constructor(params: Record<string, unknown>) {
      wsState.constructorParams = params;
    }

    start = wsState.start;
    close = wsState.close;
    get isConnecting() {
      return wsState.isConnecting;
    }
    wsConfig = {
      getWSInstance: () =>
        wsState.readyState === null ? null : { readyState: wsState.readyState },
    };
  },
}));

import { startFeishuBotWebSocket } from "../src/bots/providers/feishuProvider.js";

const bot: BotConfig = {
  id: "feishu-bot",
  name: "Feishu bot",
  provider: "feishu",
  enabled: true,
  credentialRef: "credential-ref",
  feishuAppId: "cli_0123456789abcdef",
  allowedWorkspaces: ["*"],
  allowedCommands: {},
  currentOptions: {},
  replyMode: "streaming_card",
};

describe("Feishu WebSocket lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsState.constructorParams = null;
    wsState.start.mockReset();
    wsState.start.mockResolvedValue(undefined);
    wsState.close.mockReset();
    wsState.readyState = null;
    wsState.isConnecting = false;
  });

  afterEach(() => {
    try {
      // Assert first, then fall back to cleanup; clearing the virtual clock must not mask a regression where connection polling was not released.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects startup when the SDK start promise rejects", async () => {
    wsState.start.mockRejectedValueOnce(
      new Error("pullConnectConfig failed: code=1000040351, msg=system busy"),
    );
    const startup = startFeishuBotWebSocket({
      bot,
      deps: { loadCredential: vi.fn(async () => "secret") },
      onPayload: vi.fn(async () => undefined),
    });
    const startupResult = expect(startup).rejects.toThrow("1000040351");

    await startupResult;
    expect(wsState.close).toHaveBeenCalledOnce();
  });

  it("treats the underlying open WebSocket as ready", async () => {
    let resolveStart: (() => void) | undefined;
    wsState.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    let settled = false;
    const startup = startFeishuBotWebSocket({
      bot,
      deps: { loadCredential: vi.fn(async () => "secret") },
      onPayload: vi.fn(async () => undefined),
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(wsState.constructorParams).not.toBeNull());
    expect(settled).toBe(false);
    resolveStart?.();
    wsState.readyState = 1;
    await vi.advanceTimersByTimeAsync(100);

    const client = await startup;
    try {
      expect(client).toMatchObject({ close: expect.any(Function) });
      expect(wsState.constructorParams).not.toHaveProperty("onReady");
      expect(wsState.constructorParams).not.toHaveProperty("onError");
    } finally {
      // After connecting, polling still belongs to this client; leaving it open would, after the next test
      // resets the shared mocks, misjudge reconnect exhaustion, trigger an extra close call, and leave an
      // unhandled terminated rejection.
      client.close();
    }
    await expect(client.terminated).resolves.toBeUndefined();
    expect(wsState.close).toHaveBeenCalledOnce();
  });

  it("rejects an invalid App ID before constructing the SDK client", async () => {
    await expect(
      startFeishuBotWebSocket({
        bot: { ...bot, feishuAppId: "cli_invalid" },
        deps: { loadCredential: vi.fn(async () => "secret") },
        onPayload: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Invalid Feishu App ID");
    expect(wsState.constructorParams).toBeNull();
  });

  it("closes and rejects when startup is aborted before ready", async () => {
    wsState.start.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const startup = startFeishuBotWebSocket({
      bot,
      deps: { loadCredential: vi.fn(async () => "secret") },
      onPayload: vi.fn(async () => undefined),
      signal: controller.signal,
    });
    const startupResult = expect(startup).rejects.toThrow("aborted");

    await vi.waitFor(() => expect(wsState.constructorParams).not.toBeNull());
    controller.abort();
    await startupResult;
    expect(wsState.close).toHaveBeenCalledOnce();
  });

  it("times out startup when the underlying WebSocket never opens", async () => {
    wsState.start.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const startup = startFeishuBotWebSocket({
      bot,
      deps: { loadCredential: vi.fn(async () => "secret") },
      onPayload: vi.fn(async () => undefined),
    });
    const startupResult = expect(startup).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(20_000);
    await startupResult;
    expect(wsState.close).toHaveBeenCalledOnce();
  });

  it("reports reconnect transitions and rejects terminated after reconnect exhausts", async () => {
    const onConnectionStateChange = vi.fn();
    wsState.readyState = 1;
    const clientPromise = startFeishuBotWebSocket({
      bot,
      deps: { loadCredential: vi.fn(async () => "secret") },
      onPayload: vi.fn(async () => undefined),
      onConnectionStateChange,
    });
    await vi.advanceTimersByTimeAsync(100);
    const client = await clientPromise;

    wsState.readyState = null;
    wsState.isConnecting = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("reconnecting");

    wsState.readyState = 1;
    wsState.isConnecting = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(onConnectionStateChange).toHaveBeenLastCalledWith("connected");

    wsState.readyState = null;
    wsState.isConnecting = true;
    await vi.advanceTimersByTimeAsync(100);
    const terminated = expect(client.terminated).rejects.toThrow("reconnect exhausted");
    wsState.isConnecting = false;
    await vi.advanceTimersByTimeAsync(100);
    await terminated;
    expect(wsState.close).toHaveBeenCalledOnce();
  });

  it.each(["feishu", "lark"] as const)(
    "preserves the %s domain after loading the SDK",
    async (provider) => {
      wsState.readyState = 1;
      const startup = startFeishuBotWebSocket({
        bot: { ...bot, provider },
        deps: { loadCredential: vi.fn(async () => "secret") },
        onPayload: vi.fn(async () => undefined),
      });
      await vi.advanceTimersByTimeAsync(100);
      const client = await startup;
      try {
        expect(wsState.constructorParams?.domain).toBe(
          provider === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
        );
      } finally {
        client.close();
      }
    },
  );

  it("does not construct a late client when cancelled during SDK loading", async () => {
    vi.resetModules();
    const sdkRequested = vi.fn();
    const constructClient = vi.fn();
    let finishImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      finishImport = resolve;
    });
    vi.doMock("@larksuiteoapi/node-sdk", async () => {
      sdkRequested();
      await importGate;
      return { WSClient: constructClient };
    });
    try {
      const { startFeishuBotWebSocket: start } =
        await import("../src/bots/providers/feishuProvider.js");
      expect(sdkRequested).not.toHaveBeenCalled();
      const onPayload = vi.fn(async () => undefined);
      const deps = { loadCredential: vi.fn(async () => "secret") };
      await expect(
        start({ bot: { ...bot, feishuAppId: "invalid" }, deps, onPayload }),
      ).rejects.toThrow("Invalid Feishu App ID");
      await expect(
        start({ bot, deps: { loadCredential: vi.fn(async () => null) }, onPayload }),
      ).rejects.toThrow("App Secret are required");
      await expect(start({ bot, deps, onPayload, signal: AbortSignal.abort() })).rejects.toThrow(
        "aborted",
      );
      expect(sdkRequested).not.toHaveBeenCalled();
      const controller = new AbortController();
      const startup = start({
        bot,
        deps: { loadCredential: vi.fn(async () => "secret") },
        onPayload: vi.fn(async () => undefined),
        signal: controller.signal,
      });
      const rejected = expect(startup).rejects.toThrow("aborted");
      await vi.waitFor(() => expect(sdkRequested).toHaveBeenCalledOnce());
      controller.abort();
      finishImport?.();
      await rejected;
      expect(constructClient).not.toHaveBeenCalled();
    } finally {
      finishImport?.();
      vi.doUnmock("@larksuiteoapi/node-sdk");
      vi.resetModules();
    }
  });
});
