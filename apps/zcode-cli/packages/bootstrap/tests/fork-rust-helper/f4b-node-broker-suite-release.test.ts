// Fork F4b: Node's browser control broker suite, copied with only the import paths changed. The helper reuses that
// broker unchanged (F4-D5), so these cases are its oracle on the helper path.
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import { createProtocolBrowserControlBroker } from "../../src/zcode-protocol/browser-control-broker.js";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";

const IAB_DESCRIPTOR = {
  id: "iab-runtime-1",
  generation: 1,
  type: "iab" as const,
  name: "ZCode In-app Browser",
  capabilities: {
    browser: [{ id: "visibility", description: "Browser visibility control" }],
    tab: [{ id: "cdp", description: "Controlled CDP commands" }],
  },
};

function createContext(
  requestClient: ReturnType<typeof vi.fn>,
  options: {
    deliveryKind?: "desktop-continuous" | "web-remote-replayable";
    remoteSessionId?: string;
    sessionId?: string;
    workspaceIdentity?: string;
    workspaceKey?: string;
    workspacePath?: string;
  } = {},
): ZCodeProtocolAgentServerContext {
  const sessionId = options.sessionId ?? "sess-1";
  const workspacePath = options.workspacePath ?? "/repo";
  return {
    requestClient,
    sessions: new Map([
      [
        sessionId,
        {
          deliveryKind: options.deliveryKind,
          workspace: {
            workspaceKey: options.workspaceKey ?? workspacePath,
            workspacePath,
            ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          },
        },
      ],
    ]),
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("浏览器控制资源在 runtime 退出后释放", () => {
  function setup() {
    const requestClient = vi.fn(async (..._args: unknown[]) => ({ ok: true, elapsedMs: 0 }));
    const context = createContext(requestClient, {
      workspaceIdentity: "ssh://example.com/repo",
      remoteSessionId: "remote-1",
      deliveryKind: "web-remote-replayable",
    });
    const isReady = vi.fn(() => true);
    context.sessionLifecycle = { isReady } as unknown as NonNullable<
      typeof context.sessionLifecycle
    >;
    const broker = createProtocolBrowserControlBroker(context);
    const use = (sessionId = "sess-1", browserId = "browser-1") =>
      broker.execute({
        sessionId,
        browserId,
        browserGeneration: 3,
        command: { method: "getState" },
      });
    const stop = () => {
      isReady.mockReturnValue(false);
      context.sessions.delete("sess-1");
    };
    return { requestClient, context, broker, use, stop };
  }

  it("stopping 且活动记录摘除后，轮尾和关闭仍发送完整旧路由；新请求仍拒绝", async () => {
    const s = setup();
    await s.use();
    s.stop();
    await expect(s.broker.list({ sessionId: "sess-1" })).rejects.toThrow(
      "Session runtime is not ready",
    );
    await expect(s.use()).rejects.toThrow("Session runtime is not ready");
    await s.broker.turnEnded!({ sessionId: "sess-1", turnId: "turn-old" });
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.requestClient.mock.calls.slice(1).map((call) => call[1])).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        workspaceKey: "ssh://example.com/repo",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
        browserGeneration: 3,
        command: { method: "turnEnded", turnId: "turn-old" },
      }),
      expect.objectContaining({
        sessionId: "sess-1",
        workspaceKey: "ssh://example.com/repo",
        remoteSessionId: "remote-1",
        command: { method: "closeSession" },
      }),
    ]);
    s.requestClient.mockClear();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.requestClient).not.toHaveBeenCalled();
  });

  it("取消在途请求复用原路由和目标 requestId，不查询已关闭 runtime", async () => {
    const s = setup();
    const controller = new AbortController();
    s.requestClient.mockImplementation(async (...args: unknown[]) => {
      const params = args[1] as { command: { method: string } };
      if (params.command.method === "cancelRequest") return { ok: true, elapsedMs: 0 };
      return await new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    });
    const pending = s.broker.execute({
      sessionId: "sess-1",
      browserId: "browser-1",
      browserGeneration: 3,
      command: { method: "getState" },
      signal: controller.signal,
    });
    const outcome = expect(pending).rejects.toThrow("cancelled");
    const original = s.requestClient.mock.calls[0]![1] as { requestId: string };
    s.stop();
    controller.abort();
    await outcome;
    expect(s.requestClient).toHaveBeenCalledTimes(2);
    const cancel = s.requestClient.mock.calls[1]![1] as { requestId: string };
    expect(cancel).toMatchObject({
      workspaceKey: "ssh://example.com/repo",
      remoteSessionId: "remote-1",
      command: { method: "cancelRequest", requestId: original.requestId },
    });
    expect(cancel.requestId).not.toBe(original.requestId);
  });

  it.each(["reject", "result"])(
    "多目标 %s 失败必须上报，成功项移除，重试只清理失败项",
    async (kind) => {
      const s = setup();
      await s.use();
      await s.use("sess-1", "browser-2");
      s.stop();
      const pending = Promise.withResolvers<{ ok: boolean; elapsedMs: number }>();
      s.requestClient.mockImplementation(async (...args: unknown[]) => {
        const params = args[1] as { browserId: string };
        if (params.browserId === "browser-2") return pending.promise;
        if (kind === "reject") throw new Error("close transport failed");
        return {
          ok: false,
          error: { code: "execution_error", message: "close backend failed" },
          elapsedMs: 0,
        };
      });
      let finished = false;
      const closing = s.broker.closeSession!({ sessionId: "sess-1" });
      void closing.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await Promise.resolve();
      expect(finished).toBe(false);
      const rejected = expect(closing).rejects.toThrow();
      pending.resolve({ ok: true, elapsedMs: 0 });
      await rejected;
      s.requestClient.mockClear();
      s.requestClient.mockResolvedValue({ ok: true, elapsedMs: 0 });
      await s.broker.closeSession!({ sessionId: "sess-1" });
      expect(s.requestClient).toHaveBeenCalledTimes(1);
      expect(s.requestClient.mock.calls[0]![1]).toMatchObject({ browserId: "browser-1" });
    },
  );

  it("独立子会话在父记录摘除后仍能清理；失败后保留记录供最终关闭重试", async () => {
    const s = setup();
    const child = s.broker.forChildSession!({ childSessionId: "child", parentSessionId: "sess-1" });
    await s.use("child");
    s.stop();
    s.requestClient.mockRejectedValueOnce(new Error("close failed"));
    await expect(child.closeSession!({ sessionId: "child" })).rejects.toThrow();
    s.requestClient.mockClear();
    await child.closeSession!({ sessionId: "child" });
    expect(s.requestClient).toHaveBeenCalledTimes(1);
    expect(s.requestClient.mock.calls[0]![1]).toMatchObject({
      sessionId: "child",
      workspaceKey: "ssh://example.com/repo",
      command: { method: "closeSession", closeTabs: true },
    });
  });

  it("共用父标签页的 child 关闭不清理父资源，父关闭仍使用原路由", async () => {
    const s = setup();
    const child = s.broker.forChildSession!({
      childSessionId: "child",
      parentSessionId: "sess-1",
      tabOwner: "parent",
    });
    await s.use("child");
    s.stop();
    s.requestClient.mockClear();
    await child.closeSession!({ sessionId: "child" });
    expect(s.requestClient).not.toHaveBeenCalled();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.requestClient.mock.calls[0]![1]).toMatchObject({
      sessionId: "sess-1",
      command: { method: "closeSession" },
    });
  });

  it("旧关闭完成不删除同 key 下新登记的连接", async () => {
    const s = setup();
    await s.use();
    const pending = Promise.withResolvers<{ ok: boolean; elapsedMs: number }>();
    s.requestClient.mockImplementationOnce(() => pending.promise);
    const closing = s.broker.closeSession!({ sessionId: "sess-1" });
    await s.use();
    pending.resolve({ ok: true, elapsedMs: 0 });
    await closing;
    s.requestClient.mockClear();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.requestClient).toHaveBeenCalledTimes(1);
  });

  it("旧 child 的迟到关闭不会撤销同父会话下的新 child 绑定", async () => {
    const s = setup();
    const old = s.broker.forChildSession!({
      childSessionId: "child",
      parentSessionId: "sess-1",
      tabOwner: "parent",
    });
    s.broker.forChildSession!({
      childSessionId: "child",
      parentSessionId: "sess-1",
      tabOwner: "parent",
    });
    await old.closeSession!({ sessionId: "child" });
    await s.use("child");
    expect(s.requestClient.mock.calls[0]![1]).toMatchObject({ sessionId: "sess-1" });
  });
});

describe("有 owner 确认的 browser control scope", () => {
  function scopedBackend() {
    const calls: Array<Record<string, any>> = [];
    const respond = vi.fn(async (params: any) => ({
      ok: true,
      elapsedMs: 0,
      ...(params.command.method === "openScope"
        ? { scope: { id: params.controlScopeId, state: "open" } }
        : {}),
      ...(params.command.method === "releaseScope"
        ? { scope: { id: params.controlScopeId, state: "released" } }
        : {}),
    }));
    const context = createContext(
      vi.fn(async (method, params) => {
        if (method === zcodeProtocolMethods.interactionBrowserList)
          return {
            browsers: [{ ...IAB_DESCRIPTOR, metadata: { controlScopes: "1" } }],
          };
        calls.push(params);
        return respond(params);
      }),
    );
    const broker = createProtocolBrowserControlBroker(context);
    const use = () =>
      broker.execute({
        sessionId: "sess-1",
        browserId: IAB_DESCRIPTOR.id,
        browserGeneration: 1,
        command: { method: "getState" },
      });
    return { context, broker, calls, respond, use };
  }

  it("建立结果未知后并发业务用同一 ID 重试，已确认后不再建立", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    s.respond.mockRejectedValueOnce(new Error("response lost"));
    await expect(s.use()).rejects.toThrow("response lost");
    await Promise.all([s.use(), s.use()]);
    await s.use();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.map((c) => c.command.method)).toEqual([
      "openScope",
      "openScope",
      "getState",
      "getState",
      "getState",
      "releaseScope",
    ]);
    expect(new Set(s.calls.map((c) => c.controlScopeId)).size).toBe(1);
  });

  it("建立未知后关闭优先，迟到重试不执行业务或另建 scope", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    s.respond.mockRejectedValueOnce(new Error("response lost"));
    await expect(s.use()).rejects.toThrow();
    const opened = Promise.withResolvers<any>();
    s.respond.mockImplementationOnce(() => opened.promise);
    const retry = s.use().catch((error: Error) => error);
    const close = s.broker.closeSession!({ sessionId: "sess-1" });
    await expect(s.use()).rejects.toThrow("closing");
    const id = s.calls[0]!.controlScopeId;
    opened.resolve({ ok: true, elapsedMs: 0, scope: { id, state: "open" } });
    expect(await retry).toMatchObject({ message: "Browser control scope is closing" });
    await close;
    expect(s.calls.map((c) => c.command.method)).toEqual([
      "openScope",
      "openScope",
      "releaseScope",
    ]);
    expect(new Set(s.calls.map((c) => c.controlScopeId)).size).toBe(1);
  });

  it("并发首次执行共享建立；关闭只释放已确认的实例作用域", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    await Promise.all([s.use(), s.use()]);
    s.context.sessions.clear();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.map((c) => c.command.method)).toEqual([
      "openScope",
      "getState",
      "getState",
      "releaseScope",
    ]);
    expect(new Set(s.calls.map((c) => c.controlScopeId)).size).toBe(1);
  });

  it("建立明确拒绝不会留下清理负担，也不会执行浏览器操作", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    s.respond.mockImplementation(
      async (p) =>
        ({
          ok: false,
          elapsedMs: 0,
          scope: { id: p.controlScopeId, state: "rejected" },
          error: { code: "backend_unavailable", message: "no executor" },
        }) as any,
    );
    await expect(s.use()).rejects.toThrow();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.map((c) => c.command.method)).toEqual(["openScope"]);
  });

  it("建立响应丢失仍保留释放责任；owner 明确 absent 后才删除", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    s.respond.mockRejectedValueOnce(new Error("response lost"));
    await expect(s.use()).rejects.toThrow("response lost");
    s.respond.mockImplementation(async (p) => ({
      ok: true,
      elapsedMs: 0,
      scope: { id: p.controlScopeId, state: "absent" },
    }));
    await s.broker.closeSession!({ sessionId: "sess-1" });
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.map((c) => c.command.method)).toEqual(["openScope", "releaseScope"]);
  });

  it("同任务切换客户端路由不覆盖资源，重启后的作用域不复用旧 ID", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    await s.use();
    s.context.sessions.get("sess-1")!.deliveryKind = "web-remote-replayable";
    await s.use();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    const released = s.calls.filter((c) => c.command.method === "releaseScope");
    expect(released).toHaveLength(2);
    expect(new Set(released.map((c) => c.controlScopeId)).size).toBe(2);
    await s.use();
    expect(released.map((c) => c.controlScopeId)).not.toContain(s.calls.at(-1)!.controlScopeId);
  });

  it("旧关闭回执没有 owner 确认时不得删除记录", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    await s.use();
    s.respond.mockResolvedValueOnce({ ok: true, elapsedMs: 0 });
    await expect(s.broker.closeSession!({ sessionId: "sess-1" })).rejects.toThrow();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.filter((c) => c.command.method === "releaseScope")).toHaveLength(2);
  });

  it("释放失败保留责任，不能从 backend_unavailable/sideEffect 推断成功", async () => {
    const s = scopedBackend();
    await s.broker.list({ sessionId: "sess-1" });
    await s.use();
    s.respond.mockResolvedValueOnce({
      ok: false,
      elapsedMs: 0,
      error: { code: "backend_unavailable", message: "bridge gone", sideEffect: "none" },
    } as any);
    await expect(s.broker.closeSession!({ sessionId: "sess-1" })).rejects.toThrow();
    await s.broker.closeSession!({ sessionId: "sess-1" });
    expect(s.calls.filter((c) => c.command.method === "releaseScope")).toHaveLength(2);
  });
});
