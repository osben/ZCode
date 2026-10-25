import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";

vi.mock("electron", () => ({
  app: {
    getFileIcon: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

vi.mock("../src/main/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("../src/main/fileApplications.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockNodeFsExistsSync(existingPaths: string[]) {
  const existingPathSet = new Set(existingPaths);

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      existsSync: vi.fn((path: string) => existingPathSet.has(path)),
    };
  });
}

async function importEditorsWithWindowsCommandMocks(
  existingPaths: string[],
  whereOutput: string,
  whereError?: Error,
) {
  setProcessPlatform("win32");
  mockNodeFsExistsSync(existingPaths);

  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      execFileSync: vi.fn((file: string, args: string[]) => {
        if (file === "where.exe" && args[0] === "code") {
          if (whereError) {
            throw whereError;
          }
          return whereOutput;
        }
        return "";
      }),
    };
  });

  return import("../src/main/editors.js");
}

async function importEditorsWithExistingPaths(platform: NodeJS.Platform, existingPaths: string[]) {
  setProcessPlatform(platform);
  mockNodeFsExistsSync(existingPaths);

  return import("../src/main/editors.js");
}

describe("editors", () => {
  it("macOS 应把 VS Code Insiders 识别为可用编辑器", async () => {
    setProcessPlatform("darwin");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");

    expect(getEditorDefsForCurrentPlatform()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "vscode-insiders",
          name: "VS Code Insiders",
          appPath: "/Applications/Visual Studio Code - Insiders.app",
          command: "code-insiders",
        }),
      ]),
    );
  });

  it("macOS 应把 QSpace 和 QSpace Pro 识别为可用的第三方文件管理器", async () => {
    setProcessPlatform("darwin");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");

    expect(getEditorDefsForCurrentPlatform()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qspace",
          name: "QSpace",
          appPath: "/Applications/QSpace.app",
          command: null,
        }),
        expect.objectContaining({
          id: "qspace-pro",
          name: "QSpace Pro",
          appPath: "/Applications/QSpace Pro.app",
          command: null,
        }),
      ]),
    );
  });

  it("macOS detects JetBrains IDEs installed by Toolbox under ~/Applications", async () => {
    const toolboxAppPath = join(homedir(), "Applications", "IntelliJ IDEA.app");
    const { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } =
      await importEditorsWithExistingPaths("darwin", [toolboxAppPath]);

    const ideaDef = getEditorDefsForCurrentPlatform().find((def) => def.id === "idea");
    if (!ideaDef) {
      throw new Error("missing idea editor def");
    }

    expect(resolveEditorDefAppPath(ideaDef)).toBe(toolboxAppPath);
  });

  it("macOS adds Android Studio with user-level app candidates", async () => {
    const toolboxAppPath = join(homedir(), "Applications", "Android Studio.app");
    const { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } =
      await importEditorsWithExistingPaths("darwin", [toolboxAppPath]);

    const androidStudioDef = getEditorDefsForCurrentPlatform().find(
      (def) => def.id === "android-studio",
    );
    if (!androidStudioDef) {
      throw new Error("missing android-studio editor def");
    }

    expect(androidStudioDef.appPath).toBe("/Applications/Android Studio.app");
    expect(androidStudioDef.appPathCandidates).toEqual([
      toolboxAppPath,
      join(homedir(), "Applications", "JetBrains Toolbox", "Android Studio.app"),
    ]);
    expect(resolveEditorDefAppPath(androidStudioDef)).toBe(toolboxAppPath);
  });

  it("Windows names the system file manager in English instead of a hardcoded locale string", async () => {
    setProcessPlatform("win32");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");
    const explorerDef = getEditorDefsForCurrentPlatform().find((def) => def.id === "explorer");

    expect(explorerDef?.name).toBe("File Explorer");
  });

  it("Windows detects JetBrains IDEs installed by the Toolbox apps layout", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "zcode-editors-toolbox-"));
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = pathWin32.join(fixtureRoot, "Local");
    const programsRoot = pathWin32.join(process.env.LOCALAPPDATA, "Programs");
    const directIdeaDir = pathWin32.join(programsRoot, "IntelliJ IDEA Ultimate");
    const directIdeaExe = pathWin32.join(directIdeaDir, "bin", "idea64.exe");
    const appsRoot = pathWin32.join(process.env.LOCALAPPDATA, "JetBrains", "Toolbox", "apps");
    const ideaDir = pathWin32.join(appsRoot, "IDEA-U");
    const channelDir = pathWin32.join(ideaDir, "ch-0");
    const legacyIdeaExe = pathWin32.join(channelDir, "243.21565.193", "bin", "idea64.exe");
    // Only the Community edition is installed: the missing PyCharm-P directory must not stop
    // the scan from finding its sibling app code.
    const pycharmDir = pathWin32.join(appsRoot, "PyCharm-C");
    const pycharmChannelDir = pathWin32.join(pycharmDir, "ch-1");
    const pycharmExe = pathWin32.join(pycharmChannelDir, "2026.1.2", "bin", "pycharm64.exe");
    const directories = new Map<string, string[]>([
      [programsRoot, ["IntelliJ IDEA Ultimate"]],
      [appsRoot, ["IDEA-U", "PyCharm-C"]],
      [ideaDir, ["ch-0", "settings.json"]],
      // A legacy short-numbered build must sort below the current one: a lexical sort would
      // place "99.5.1" above "243.21565.193" and resolve the older build first.
      [channelDir, ["243.21565.193", "242.2365.12", "99.5.1"]],
      [pycharmDir, ["ch-1"]],
      [pycharmChannelDir, ["2026.1.2"]],
    ]);
    const files = new Set<string>([
      pathWin32.join(ideaDir, "settings.json"),
      directIdeaExe,
      legacyIdeaExe,
      pathWin32.join(channelDir, "99.5.1", "bin", "idea64.exe"),
      pycharmExe,
    ]);

    try {
      setProcessPlatform("win32");
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: vi.fn((path: string) => files.has(path)),
          readdirSync: vi.fn((path: string, options?: { withFileTypes?: boolean }) => {
            const names = directories.get(path);
            if (!names) {
              // Missing directories must throw like the real readdirSync so the scan's
              // per-app-code error handling is actually exercised.
              throw Object.assign(
                new Error(`ENOENT: no such file or directory, scandir '${path}'`),
                { code: "ENOENT" },
              );
            }
            if (!options?.withFileTypes) {
              return names;
            }
            return names.map((name) => ({
              name,
              isDirectory: () => !files.has(pathWin32.join(path, name)),
              isFile: () => files.has(pathWin32.join(path, name)),
            }));
          }),
        };
      });

      const { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } =
        await import("../src/main/editors.js");
      const ideaDef = getEditorDefsForCurrentPlatform().find((def) => def.id === "idea");
      if (!ideaDef) {
        throw new Error("missing idea editor def");
      }
      const pycharmDef = getEditorDefsForCurrentPlatform().find((def) => def.id === "pycharm");
      if (!pycharmDef) {
        throw new Error("missing pycharm editor def");
      }

      expect(resolveEditorDefAppPath(ideaDef)).toBe(directIdeaExe);
      expect(resolveEditorDefAppPath(pycharmDef)).toBe(pycharmExe);
    } finally {
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("Windows 应把常见 IDE 纳入 workspace 顶部打开菜单候选", async () => {
    setProcessPlatform("win32");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");
    const editorIds = getEditorDefsForCurrentPlatform().map((editor) => editor.id);

    expect(editorIds).toEqual(
      expect.arrayContaining([
        "explorer",
        "vscode",
        "trae",
        "idea",
        "pycharm",
        "phpstorm",
        "rider",
        "rubymine",
        "datagrip",
        "android-studio",
      ]),
    );
  });

  it("Windows requires PATH shims to resolve to a real app exe before showing gui editors", async () => {
    const shimPath = "D:\\Microsoft VS Code\\bin\\code";
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [shimPath],
      `${shimPath}\r\n`,
    );

    expect(
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).toBeNull();
  });

  it("Windows derives the real app exe from PATH shims for display and opening", async () => {
    const shimPath = "D:\\Microsoft VS Code\\bin\\code";
    const appPath = "D:\\Microsoft VS Code\\Code.exe";
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [shimPath, appPath],
      `${shimPath}\r\n`,
    );

    expect(
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).toBe(appPath);
  });

  it("Windows handles missing where.exe without throwing while detecting gui editors", async () => {
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [],
      "",
      Object.assign(new Error("spawn where.exe ENOENT"), { code: "ENOENT" }),
    );

    expect(() =>
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).not.toThrow();
  });
});

describe("file application detection cache", () => {
  it.each(["missing", "icon", "error"])(
    "retries %s results without restarting and shares pending detection",
    async (failure) => {
      setProcessPlatform("linux");
      const resolveFileApplicationPath = vi.fn();
      vi.doMock("../src/main/fileApplications.js", () => ({
        getFileApplicationDefs: () => [{ id: "reader", name: "Reader" }],
        matchesFileApplication: () => true,
        resolveFileApplicationPath,
      }));
      const { app } = await import("electron");
      vi.mocked(app.getFileIcon).mockResolvedValue({ toPNG: () => Buffer.from("icon") } as never);
      if (failure === "missing") resolveFileApplicationPath.mockResolvedValueOnce(null);
      else if (failure === "error")
        resolveFileApplicationPath.mockRejectedValueOnce(new Error("detection failed"));
      else {
        resolveFileApplicationPath.mockResolvedValueOnce("/usr/bin/reader");
        vi.mocked(app.getFileIcon).mockImplementation(async (path) => {
          if (path === "/usr/bin/reader") throw new Error("icon unavailable");
          return { toPNG: () => Buffer.from("icon") } as never;
        });
      }
      const { getInstalledEditors } = await import("../src/main/editors.js");
      if (failure === "error")
        await expect(getInstalledEditors("/work/a.pdf")).rejects.toThrow("detection failed");
      else
        expect(await getInstalledEditors("/work/a.pdf")).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "reader" })]),
        );
      resolveFileApplicationPath.mockResolvedValue("/usr/bin/reader");
      vi.mocked(app.getFileIcon).mockResolvedValue({ toPNG: () => Buffer.from("icon") } as never);
      const results = await Promise.all([
        getInstalledEditors("/work/a.pdf"),
        getInstalledEditors("/work/b.pdf"),
      ]);
      for (const result of results)
        expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: "reader" })]));
      expect(resolveFileApplicationPath).toHaveBeenCalledTimes(2);
      await getInstalledEditors("/work/c.pdf");
      expect(resolveFileApplicationPath).toHaveBeenCalledTimes(2);
    },
  );
});
