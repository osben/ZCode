import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  shellOpenPath: vi.fn(),
  shellShowItemInFolder: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openPath: h.shellOpenPath,
    showItemInFolder: h.shellShowItemInFolder,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: h.execFile,
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

describe("openPathInFileManager", () => {
  let root: string;

  beforeEach(async () => {
    h.shellOpenPath.mockReset().mockResolvedValue("");
    h.shellShowItemInFolder.mockReset();
    h.execFile.mockReset().mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as (error: Error | null) => void)(null);
    });
    root = await mkdtemp(join(tmpdir(), "zcode-file-manager-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reveals a file with selection instead of opening its default application", async () => {
    const { openPathInFileManager } = await import("../src/main/desktopMainIpcHelpers.js");
    const file = join(root, "book.epub");
    await writeFile(file, "content");

    const result = await openPathInFileManager(file, { warn: vi.fn() });

    // The lexical path is revealed, not realpath's resolution of symlinked temp directories.
    expect(result).toEqual({ success: true });
    expect(h.shellShowItemInFolder).toHaveBeenCalledTimes(1);
    expect(h.shellShowItemInFolder).toHaveBeenCalledWith(file);
    expect(h.shellOpenPath).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("reveals a symlink itself, not its destination outside the folder", async () => {
    const { openPathInFileManager } = await import("../src/main/desktopMainIpcHelpers.js");
    const outside = await mkdtemp(join(tmpdir(), "zcode-file-manager-out-"));
    try {
      const destination = join(outside, "report.pdf");
      await writeFile(destination, "content");
      const link = join(root, "report.link.pdf");
      await symlink(destination, link);

      const result = await openPathInFileManager(link, { warn: vi.fn() });

      expect(result).toEqual({ success: true });
      expect(h.shellShowItemInFolder).toHaveBeenCalledTimes(1);
      expect(h.shellShowItemInFolder).toHaveBeenCalledWith(link);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "reveals an application bundle instead of launching it",
    async () => {
      const { openPathInFileManager } = await import("../src/main/desktopMainIpcHelpers.js");
      const bundle = join(root, "Evil.app");
      await mkdir(bundle);

      const result = await openPathInFileManager(bundle, { warn: vi.fn() });

      // Directories keep the pre-existing realpath resolution; only files reveal lexically.
      expect(result).toEqual({ success: true });
      expect(h.shellShowItemInFolder).toHaveBeenCalledTimes(1);
      expect(h.shellShowItemInFolder).toHaveBeenCalledWith(await realpath(bundle));
      expect(h.shellOpenPath).not.toHaveBeenCalled();
      expect(h.execFile).not.toHaveBeenCalled();
    },
  );

  it("opens a directory as a folder without item selection", async () => {
    const { openPathInFileManager } = await import("../src/main/desktopMainIpcHelpers.js");
    const realRoot = await realpath(root);

    const result = await openPathInFileManager(root, { warn: vi.fn() });

    expect(result).toEqual({ success: true });
    expect(h.shellShowItemInFolder).not.toHaveBeenCalled();
    if (process.platform === "darwin") {
      expect(h.execFile).toHaveBeenCalledTimes(1);
      expect(h.execFile.mock.calls[0]?.[0]).toBe("open");
      expect(h.execFile.mock.calls[0]?.[1]).toEqual([realRoot]);
    } else {
      expect(h.shellOpenPath).toHaveBeenCalledWith(realRoot);
    }
  });

  it("falls back to the parent directory when the entry no longer exists", async () => {
    const { openPathInFileManager } = await import("../src/main/desktopMainIpcHelpers.js");

    const result = await openPathInFileManager(join(root, "deleted.epub"), { warn: vi.fn() });

    // realpath cannot resolve the missing entry, so the parent keeps its normalized form.
    expect(result).toEqual({ success: true });
    expect(h.shellShowItemInFolder).not.toHaveBeenCalled();
    if (process.platform === "darwin") {
      expect(h.execFile).toHaveBeenCalledTimes(1);
      expect(h.execFile.mock.calls[0]?.[0]).toBe("open");
      expect(h.execFile.mock.calls[0]?.[1]).toEqual([root]);
    } else {
      expect(h.shellOpenPath).toHaveBeenCalledWith(root);
    }
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
