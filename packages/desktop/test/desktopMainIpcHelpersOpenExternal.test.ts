import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  shellOpenPath: vi.fn(),
  shellShowItemInFolder: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openPath: h.shellOpenPath,
    showItemInFolder: h.shellShowItemInFolder,
  },
}));

describe("openPathInDefaultApp", () => {
  beforeEach(() => {
    h.shellOpenPath.mockReset();
    h.shellShowItemInFolder.mockReset();
  });

  it("uses shell.openPath for a local HTML file and reports success", async () => {
    h.shellOpenPath.mockResolvedValue("");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp("E:\\项目\\preview page.html", logger);

    expect(h.shellOpenPath).toHaveBeenCalledWith("E:\\项目\\preview page.html");
    expect(result).toEqual({ success: true });
    expect(logger.info).toHaveBeenCalledWith("[open-external] 本地文件打开成功", {
      path: "E:\\项目\\preview page.html",
    });
  });

  it("returns and logs the shell error instead of failing silently", async () => {
    h.shellOpenPath.mockResolvedValue("No application is associated with the specified file");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp("E:\\preview.html", logger);

    expect(result).toEqual({
      success: false,
      error: "No application is associated with the specified file",
    });
    expect(logger.warn).toHaveBeenCalledWith("[open-external] 本地文件打开失败", {
      path: "E:\\preview.html",
      error: "No application is associated with the specified file",
    });
  });
});

describe.skipIf(process.platform === "win32")("openPathInDefaultApp executable targets", () => {
  let root: string;

  beforeEach(async () => {
    h.shellOpenPath.mockReset();
    h.shellShowItemInFolder.mockReset();
    h.shellOpenPath.mockResolvedValue("");
    root = await mkdtemp(join(tmpdir(), "zcode-open-path-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("still opens a plain document", async () => {
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const document = join(root, "page.html");
    await writeFile(document, "<html></html>");

    const result = await openPathInDefaultApp(document, { info: vi.fn(), warn: vi.fn() });

    expect(result).toEqual({ success: true });
    expect(h.shellOpenPath).toHaveBeenCalledTimes(1);
    expect(h.shellShowItemInFolder).not.toHaveBeenCalled();
  });

  it.each([
    ["an .app bundle", "Evil.app", "dir"],
    ["a .command script", "run.COMMAND", "file"],
    ["an extensionless file with an execute bit", "payload", "exec"],
  ] as const)("reveals %s instead of opening it", async (_label, name, kind) => {
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const target = join(root, name);
    if (kind === "dir") await mkdir(target);
    else await writeFile(target, "#!/bin/sh\n");
    if (kind === "exec") await chmod(target, 0o755);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp(target, logger);

    expect(result).toEqual({ success: false, error: "executable-target-blocked" });
    expect(h.shellOpenPath).not.toHaveBeenCalled();
    expect(h.shellShowItemInFolder).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("isExecutableOpenTarget", () => {
  const file = { isFile: true, isDirectory: false, mode: 0o644 };

  it.each([
    ["C:\\Users\\me\\evil.EXE.", true],
    ["C:\\Users\\me\\run.bat", true],
    ["C:\\Users\\me\\shortcut.lnk ", true],
    ["C:\\Users\\me\\tool.custom", true],
    ["C:\\Users\\me\\report.pdf", false],
    ["C:\\Users\\me\\page.html", false],
  ])("on Windows classifies %s as executable: %s", async (target, expected) => {
    const { isExecutableOpenTarget } = await import("../src/main/desktopMainIpcHelpers.js");

    expect(isExecutableOpenTarget(target, file, "win32", ".COM;.EXE;.CUSTOM")).toBe(expected);
  });

  it("on Linux treats .desktop launchers and execute bits as executable", async () => {
    const { isExecutableOpenTarget } = await import("../src/main/desktopMainIpcHelpers.js");

    expect(isExecutableOpenTarget("/home/me/app.desktop", file, "linux")).toBe(true);
    expect(isExecutableOpenTarget("/home/me/notes.txt", { ...file, mode: 0o700 }, "linux")).toBe(
      true,
    );
    expect(isExecutableOpenTarget("/home/me/notes.txt", file, "linux")).toBe(false);
    expect(
      isExecutableOpenTarget(
        "/home/me/project",
        { isFile: false, isDirectory: true, mode: 0o755 },
        "linux",
      ),
    ).toBe(false);
  });
});
