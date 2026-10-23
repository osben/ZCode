import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

import { isDockerAvailable, probeDockerDaemon } from "../src/remote/docker-detect.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function respondWith(error: (Error & { code?: number }) | null, stdout = "", stderr = ""): void {
  mocks.execFile.mockImplementation(
    (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      callback(error, stdout, stderr);
    },
  );
}

describe("Docker daemon probe", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("probeDockerDaemon 应执行 docker version 读取 Server 版本，成功时不返回输出", async () => {
    respondWith(null, "27.3.1\n");

    await expect(probeDockerDaemon()).resolves.toBeUndefined();

    expect(mocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ["version", "--format", "{{.Server.Version}}"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("daemon 未运行时 probeDockerDaemon 应以 stderr 原因拒绝", async () => {
    respondWith(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "",
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
    );

    await expect(probeDockerDaemon()).rejects.toThrow(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
    );
  });

  it("stderr 为空时 probeDockerDaemon 应回退为进程错误信息", async () => {
    respondWith(new Error("spawn docker ENOENT"), "", "");

    await expect(probeDockerDaemon()).rejects.toThrow("spawn docker ENOENT");
  });

  it("isDockerAvailable 应把任何探测失败视为不可用，成功时返回 true", async () => {
    respondWith(new Error("daemon down"), "", "");
    await expect(isDockerAvailable()).resolves.toBe(false);

    respondWith(null, "27.3.1\n");
    await expect(isDockerAvailable()).resolves.toBe(true);
  });
});
