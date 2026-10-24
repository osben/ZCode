import { describe, expect, it, vi } from "vitest";
import {
  createWindowHostAttachmentFlowForwarder,
  createWindowHostAttachmentRegistry,
} from "../src/host/windowHostAttachmentRegistry.js";

function createPort() {
  let closeListener: (() => void) | null = null;
  return {
    port: {
      once(event: "close", listener: () => void) {
        if (event === "close") {
          closeListener = listener;
        }
      },
    },
    close() {
      closeListener?.();
    },
  };
}

describe("WindowHostAttachmentRegistry", () => {
  it("base 与 remote scope 在同一个 Host 内解析各自 services", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: (scope) =>
        scope.kind === "local"
          ? { services: "local-services", generation: 1 }
          : { services: `remote-services:${scope.remoteSessionId}`, generation: 7 },
      expose,
    });
    const localPort = createPort();
    const remotePort = createPort();

    registry.attach({
      requestId: "attach-local",
      attachmentId: "local-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: localPort.port,
    });
    registry.attach({
      requestId: "attach-remote",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: remotePort.port,
    });

    expect(expose).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ services: "local-services", clientMode: "desktop-continuous" }),
    );
    expect(expose).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        services: "remote-services:remote-session-1",
        clientMode: "desktop-continuous",
        generation: 7,
      }),
    );
    expect(registry.size()).toBe(2);
  });

  it("每个 attachment 注入自己的可信 clientMode", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });

    registry.attach({
      requestId: "desktop-1",
      attachmentId: "desktop-1",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(expose.mock.calls.map(([call]) => call.clientMode)).toEqual([
      "desktop-continuous",
      "web-remote-replayable",
    ]);
  });

  it("将 remote connection capabilities 一并注入 attachment，供媒体服务按 clientMode 分流", () => {
    const expose = vi.fn(() => ({ dispose: vi.fn() }));
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({
        services: "services",
        generation: 1,
        capabilities: { remoteMediaPreview: "available" },
      }),
      expose,
    });

    registry.attach({
      requestId: "remote-1",
      attachmentId: "remote-1",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      },
      port: createPort().port,
    });

    expect(expose).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: { remoteMediaPreview: "available" } }),
    );
  });

  it("相同 attachmentId 替换时只释放旧 port，其他 port 不受影响", () => {
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const mobileDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: firstDispose })
      .mockReturnValueOnce({ dispose: mobileDispose })
      .mockReturnValueOnce({ dispose: secondDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });

    registry.attach({
      requestId: "desktop-old",
      attachmentId: "desktop",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "mobile",
      attachmentId: "mobile",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "desktop-new",
      attachmentId: "desktop",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(mobileDispose).not.toHaveBeenCalled();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(2);
  });

  it("port close 和显式 detach 均只释放自身且幂等", () => {
    const dispose = vi.fn();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose: () => ({ dispose }),
    });
    const port = createPort();
    registry.attach({
      requestId: "mobile-1",
      attachmentId: "mobile-1",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
      port: port.port,
    });

    port.close();
    registry.detach("mobile-1");
    registry.detach("mobile-1");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it("Source 离线时只释放该 Source 的 settings attachments", () => {
    const sourceDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: sourceDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    registry.attach({
      requestId: "source-settings",
      attachmentId: "source-settings",
      clientMode: "desktop-continuous",
      scope: { kind: "source-settings", sourceServerId: "source-1" },
      port: createPort().port,
    });
    registry.attach({
      requestId: "local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachSourceSettingsAttachments("source-1");

    expect(sourceDispose).toHaveBeenCalledOnce();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
  });

  it("rejects Source settings services from mobile replayable attachments", () => {
    const expose = vi.fn();
    const resolveScope = vi.fn(() => ({ services: "services", generation: 1 }));
    const registry = createWindowHostAttachmentRegistry({ resolveScope, expose });

    expect(() =>
      registry.attach({
        requestId: "mobile-source-settings",
        attachmentId: "mobile-source-settings",
        clientMode: "web-remote-replayable",
        scope: { kind: "source-settings", sourceServerId: "source-1" },
        port: createPort().port,
      }),
    ).toThrow("Desktop-only");
    expect(resolveScope).not.toHaveBeenCalled();
    expect(expose).not.toHaveBeenCalled();
  });

  it("scope 验证失败时不暴露 port", () => {
    const expose = vi.fn();
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => {
        throw new Error("远程 attachment scope 与 logical session 不匹配");
      },
      expose,
    });

    expect(() =>
      registry.attach({
        requestId: "remote-invalid",
        attachmentId: "remote-invalid",
        clientMode: "desktop-continuous",
        scope: {
          kind: "remote",
          remoteSessionId: "remote-session-1",
          workspacePath: "/work/demo",
          workspaceIdentity: "remote:ssh:wrong:/work/demo",
        },
        port: createPort().port,
      }),
    ).toThrow("远程 attachment scope 与 logical session 不匹配");
    expect(expose).not.toHaveBeenCalled();
  });

  it("logical session generation 变化时只释放该 session 的旧 attachment", () => {
    const oldDispose = vi.fn();
    const otherDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: oldDispose })
      .mockReturnValueOnce({ dispose: otherDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: (scope) => ({
        services: "services",
        generation: scope.kind === "remote" && scope.remoteSessionId === "remote-1" ? 1 : 2,
      }),
      expose,
    });
    registry.attach({
      requestId: "old",
      attachmentId: "old",
      clientMode: "web-remote-replayable",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-1",
        workspacePath: "/old",
        workspaceIdentity: "remote:ssh:old",
      },
      port: createPort().port,
    });
    registry.attach({
      requestId: "other",
      attachmentId: "other",
      clientMode: "desktop-continuous",
      scope: {
        kind: "remote",
        remoteSessionId: "remote-2",
        workspacePath: "/other",
        workspaceIdentity: "remote:ssh:other",
      },
      port: createPort().port,
    });
    registry.attach({
      requestId: "local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachStaleRemoteSessionAttachments("remote-1", 2);

    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(otherDispose).not.toHaveBeenCalled();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(2);
  });

  it("remote session 失效时释放该 session 的所有 desktop/mobile attachment 且保持幂等", () => {
    const desktopDispose = vi.fn();
    const mobileDispose = vi.fn();
    const otherRemoteDispose = vi.fn();
    const localDispose = vi.fn();
    const expose = vi
      .fn()
      .mockReturnValueOnce({ dispose: desktopDispose })
      .mockReturnValueOnce({ dispose: mobileDispose })
      .mockReturnValueOnce({ dispose: otherRemoteDispose })
      .mockReturnValueOnce({ dispose: localDispose });
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "services", generation: 1 }),
      expose,
    });
    const attachRemote = (
      attachmentId: string,
      remoteSessionId: string,
      clientMode: "desktop-continuous" | "web-remote-replayable",
    ) =>
      registry.attach({
        requestId: `request-${attachmentId}`,
        attachmentId,
        clientMode,
        scope: {
          kind: "remote",
          remoteSessionId,
          workspacePath: "/work/demo",
          workspaceIdentity: `remote:ssh:${remoteSessionId}:/work/demo`,
        },
        port: createPort().port,
      });

    attachRemote("desktop-old", "remote-old", "desktop-continuous");
    attachRemote("mobile-old", "remote-old", "web-remote-replayable");
    attachRemote("desktop-current", "remote-current", "desktop-continuous");
    registry.attach({
      requestId: "request-local",
      attachmentId: "local",
      clientMode: "desktop-continuous",
      scope: { kind: "local" },
      port: createPort().port,
    });

    registry.detachRemoteSessionAttachments("remote-old");
    registry.detachRemoteSessionAttachments("remote-old");

    expect(desktopDispose).toHaveBeenCalledTimes(1);
    expect(mobileDispose).toHaveBeenCalledTimes(1);
    expect(otherRemoteDispose).not.toHaveBeenCalled();
    expect(localDispose).not.toHaveBeenCalled();
    expect(registry.list().map((attachment) => attachment.attachmentId)).toEqual([
      "desktop-current",
      "local",
    ]);
  });

  // ISSUE-061 (specs/host-shutdown-teardown-logging.md).
  it("registry dispose 以 host-shutdown 释放 handle；detach、端口关闭与替换不带该原因", () => {
    const handles: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const registry = createWindowHostAttachmentRegistry({
      resolveScope: () => ({ services: "local-services", generation: 1 }),
      expose: () => {
        const handle = { dispose: vi.fn() };
        handles.push(handle);
        return handle;
      },
    });
    const attach = (attachmentId: string) => {
      const port = createPort();
      registry.attach({
        requestId: `request-${attachmentId}`,
        attachmentId,
        clientMode: "desktop-continuous",
        scope: { kind: "local" },
        port: port.port,
      });
      return port;
    };

    attach("detached");
    registry.detach("detached");
    const closedPort = attach("closed");
    closedPort.close();
    attach("replaced");
    attach("replaced");
    attach("shutdown");
    registry.dispose();

    expect(handles.map((handle) => handle.dispose.mock.calls)).toEqual([
      [[undefined]],
      [[undefined]],
      [[undefined]],
      [["host-shutdown"]],
      [["host-shutdown"]],
    ]);
  });
});

describe("WindowHostAttachmentFlowForwarder", () => {
  function createScope() {
    const calls: string[] = [];
    const disposedError = new Error("ZCode Protocol client disposed");
    let releaseSaturated!: () => void;
    const scope = {
      setTransportFlowState: vi.fn((state: "saturated" | "drained" | "closed") => {
        calls.push(`flow:${state}`);
        if (state === "saturated") {
          return new Promise<void>((resolve) => (releaseSaturated = resolve));
        }
        return Promise.reject(disposedError);
      }),
      dispose: vi.fn(async () => {
        calls.push("dispose");
      }),
    };
    return { scope, calls, releaseSaturated: () => releaseSaturated() };
  }

  it("host-shutdown close 不自行转发 closed，排在已入队更新之后释放 scope，且不报 warn", async () => {
    const { scope, calls, releaseSaturated } = createScope();
    const onForwardError = vi.fn();
    const forwarder = createWindowHostAttachmentFlowForwarder(scope, onForwardError);

    void forwarder.forward("saturated").catch(() => {});
    const closed = forwarder.close("host-shutdown");
    await Promise.resolve();
    expect(scope.dispose).not.toHaveBeenCalled();
    releaseSaturated();
    await closed;

    expect(calls).toEqual(["flow:saturated", "dispose"]);
    expect(onForwardError).not.toHaveBeenCalled();
  });

  it("host-shutdown 之后才失败的已入队 SAT/DRN 不报 warn；shutdown 之前的失败照常上报", async () => {
    const disposedError = new Error("ZCode Protocol client disposed");
    let rejectDrained!: (error: Error) => void;
    const scope = {
      setTransportFlowState: vi.fn((state: "saturated" | "drained" | "closed") =>
        state === "saturated"
          ? Promise.reject(new Error("live failure"))
          : new Promise<void>((_resolve, reject) => (rejectDrained = reject)),
      ),
      dispose: vi.fn(async () => {}),
    };
    const onForwardError = vi.fn();
    const forwarder = createWindowHostAttachmentFlowForwarder(scope, onForwardError);

    await forwarder.forward("saturated").catch(() => {});
    expect(onForwardError).toHaveBeenCalledExactlyOnceWith("saturated", expect.any(Error));

    const drained = forwarder.forward("drained").catch(() => {});
    await vi.waitFor(() => expect(scope.setTransportFlowState).toHaveBeenCalledTimes(2));
    const closed = forwarder.close("host-shutdown");
    rejectDrained(disposedError);
    await drained;
    await closed;

    expect(onForwardError).toHaveBeenCalledTimes(1);
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it("普通 close 先转发 closed 再释放 scope，转发失败仍上报", async () => {
    const { scope, calls } = createScope();
    const onForwardError = vi.fn();
    const forwarder = createWindowHostAttachmentFlowForwarder(scope, onForwardError);

    await forwarder.close();

    expect(calls).toEqual(["flow:closed", "dispose"]);
    expect(onForwardError).toHaveBeenCalledWith("closed", expect.any(Error));
  });

  it("没有 connection scope 时 forward 与 close 都是空操作", async () => {
    const onForwardError = vi.fn();
    const forwarder = createWindowHostAttachmentFlowForwarder(undefined, onForwardError);
    await forwarder.forward("saturated");
    await forwarder.close("host-shutdown");
    expect(onForwardError).not.toHaveBeenCalled();
  });
});
