import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IFileService } from "@zcode/services";
import { prepareRemoteWorkspaceIdentity } from "@desktop/host/remoteWorkspacePreparation.js";

const workspacePath = "/home/tester/project";

function fileServiceWith(readdir: IFileService["readdir"]): Pick<IFileService, "readdir"> {
  return { readdir } as Pick<IFileService, "readdir">;
}

describe("remote workspace directory budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("目录在预算内响应时完成身份绑定且不留下定时器", async () => {
    const bind = vi.fn(async () => undefined);
    const readdir = vi.fn(async () => []);

    const preparing = prepareRemoteWorkspaceIdentity(
      fileServiceWith(readdir as unknown as IFileService["readdir"]),
      { workspacePath, stableWorkspaceIdentity: "remote:server:fixture:/home/tester/project" },
      bind,
    );
    await preparing;

    expect(readdir).toHaveBeenCalledWith({ path: `${workspacePath}/.` });
    expect(bind).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("默认 30 秒内没有响应时应报告 remote-workspace-directory-unresponsive", async () => {
    const bind = vi.fn(async () => undefined);
    const readdir = vi.fn(() => new Promise<never>(() => undefined));

    const preparing = prepareRemoteWorkspaceIdentity(
      fileServiceWith(readdir as unknown as IFileService["readdir"]),
      { workspacePath, stableWorkspaceIdentity: "remote:server:fixture:/home/tester/project" },
      bind,
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await preparing;

    expect(error).toMatchObject({
      code: "remote-workspace-directory-unresponsive",
      retryable: true,
      message: `Remote workspace directory did not respond within 30 seconds: ${workspacePath}`,
    });
    expect(bind).not.toHaveBeenCalled();
  });

  it("预算耗尽后迟到的目录结果不得绑定工作区", async () => {
    const bind = vi.fn(async () => undefined);
    let resolveReaddir: (value: unknown[]) => void = () => undefined;
    const readdir = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveReaddir = resolve;
        }),
    );

    const preparing = prepareRemoteWorkspaceIdentity(
      fileServiceWith(readdir as unknown as IFileService["readdir"]),
      { workspacePath, stableWorkspaceIdentity: "remote:server:fixture:/home/tester/project" },
      bind,
      { timeoutMs: 1_000 },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    resolveReaddir([]);
    await vi.advanceTimersByTimeAsync(0);
    const error = await preparing;

    expect(error).toMatchObject({ code: "remote-workspace-directory-unresponsive" });
    expect(bind).not.toHaveBeenCalled();
  });

  it("目录不存在时仍报告 remote-workspace-directory-unavailable 且不报告无响应", async () => {
    const bind = vi.fn(async () => undefined);
    const readdir = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const error = await prepareRemoteWorkspaceIdentity(
      fileServiceWith(readdir as unknown as IFileService["readdir"]),
      { workspacePath, stableWorkspaceIdentity: "remote:server:fixture:/home/tester/project" },
      bind,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "remote-workspace-directory-unavailable",
      retryable: false,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(bind).not.toHaveBeenCalled();
  });

  it("调用方在开始前已取消时应直接以取消错误结束，不启动预算定时器", async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("canceled"), { name: "AbortError" }));
    const readdir = vi.fn(async () => []);

    const error = await prepareRemoteWorkspaceIdentity(
      fileServiceWith(readdir as unknown as IFileService["readdir"]),
      {
        workspacePath,
        stableWorkspaceIdentity: "remote:server:fixture:/home/tester/project",
        signal: controller.signal,
      },
      undefined,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toMatchObject({ code: "remote-workspace-directory-unresponsive" });
    expect(readdir).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
