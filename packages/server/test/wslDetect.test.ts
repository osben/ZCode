import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WSL_DISCOVERY_CACHE_TTL_MS,
  createWslExecError,
  invalidateWSLDiscoveryCache,
  isWSLAvailable,
  listWSLDistros,
} from "../src/remote/wsl-detect.js";

describe("createWslExecError", () => {
  it("优先使用 stderr 文本并追加数字退出码，同时保留 cause 与 exitCode", () => {
    const cause = Object.assign(new Error("Command failed: wsl.exe"), { code: 1 });
    const error = createWslExecError(
      cause,
      Buffer.from(""),
      Buffer.from("There is no distribution with the supplied name.\r\n"),
    );

    expect(error.message).toBe("There is no distribution with the supplied name.（退出码 1）");
    expect(Reflect.get(error, "exitCode")).toBe(1);
    expect(error.cause).toBe(cause);
  });

  it("stderr 为空时回退到 stdout 文本", () => {
    const error = createWslExecError(
      Object.assign(new Error("Command failed"), { code: 4294967295 }),
      Buffer.from("Installing, this may take a few minutes...\n"),
      Buffer.from(""),
    );

    expect(error.message).toBe("Installing, this may take a few minutes...（退出码 4294967295）");
  });

  it("stdout 与 stderr 都为空时回退到进程错误信息", () => {
    const error = createWslExecError(
      new Error("spawn wsl.exe ENOENT"),
      Buffer.from(""),
      Buffer.from(""),
    );

    expect(error.message).toBe("spawn wsl.exe ENOENT");
    expect(Reflect.has(error, "exitCode")).toBe(false);
  });

  it("非数字退出码（例如 ENOENT）不追加退出码后缀", () => {
    const error = createWslExecError(
      Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" }),
      Buffer.from(""),
      Buffer.from(""),
    );

    expect(error.message).toBe("spawn wsl.exe ENOENT");
    expect(Reflect.has(error, "exitCode")).toBe(false);
  });

  it("UTF-16LE 编码的 stderr 应先解码再去掉 NUL 与 BOM", () => {
    const error = createWslExecError(
      Object.assign(new Error("Command failed"), { code: 1 }),
      Buffer.from(""),
      Buffer.from("﻿wsl: 无法启动发行版\r\n", "utf16le"),
    );

    expect(error.message).toBe("wsl: 无法启动发行版（退出码 1）");
  });
});

describe("WSL discovery cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    invalidateWSLDiscoveryCache();
  });

  afterEach(() => {
    invalidateWSLDiscoveryCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("single-flights status discovery and refreshes after five seconds", async () => {
    const executor = vi.fn(async () => Buffer.from("ok"));

    const first = isWSLAvailable(executor);
    const second = isWSLAvailable(executor);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(executor).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(WSL_DISCOVERY_CACHE_TTL_MS - 1);
    await expect(isWSLAvailable(executor)).resolves.toBe(true);
    expect(executor).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await expect(isWSLAvailable(executor)).resolves.toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("does not retain a rejected distro-list promise", async () => {
    const executor = vi
      .fn<() => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(
        Buffer.from("  NAME      STATE      VERSION\n* Ubuntu   Running    2\n"),
      );

    await expect(listWSLDistros(executor)).rejects.toThrow("temporary failure");
    await expect(listWSLDistros(executor)).resolves.toEqual([
      { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
    ]);
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
