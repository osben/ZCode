import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const electronMocks = vi.hoisted(() => ({
  appShow: vi.fn(),
  showMessageBoxSync: vi.fn((..._args: unknown[]) => 0),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({ statSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.statSync.mockImplementation(actual.statSync);
  return { ...actual, statSync: fsMocks.statSync };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    get isPackaged() {
      return false;
    },
    setAsDefaultProtocolClient: vi.fn(() => true),
    show: electronMocks.appShow,
  },
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
    getAllWindows: electronMocks.getAllWindows,
  },
  dialog: { showMessageBoxSync: electronMocks.showMessageBoxSync },
}));

const tempDirs: string[] = [];

beforeEach(() => {
  vi.resetModules();
  electronMocks.appShow.mockClear();
  electronMocks.showMessageBoxSync.mockReset();
  electronMocks.showMessageBoxSync.mockReturnValue(0);
  electronMocks.getFocusedWindow.mockReset();
  electronMocks.getAllWindows.mockReset();
  fsMocks.statSync.mockClear();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-task-new-"));
  tempDirs.push(dir);
  return dir;
}

function createMockWindow(webContentsId: number) {
  return {
    webContents: { id: webContentsId, send: vi.fn() },
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
  };
}

function buildTaskNewUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ path, ...params });
  return `zcode://task/new?${query.toString()}`;
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("desktopOAuthDeepLink task/new routing", () => {
  it("renderer ready: confirms with a preview and sends the draft payload once", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(21);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    const handled = await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "Сделай план реализации" }),
      createLogger(),
    );

    expect(handled).toBe(true);
    expect(electronMocks.showMessageBoxSync).toHaveBeenCalledTimes(1);
    const dialogOptions = electronMocks.showMessageBoxSync.mock.calls[0]!.at(-1) as {
      detail: string;
    };
    expect(dialogOptions.detail).toContain(workspacePath);
    expect(dialogOptions.detail).toContain("Сделай план реализации");
    expect(targetWindow.webContents.send).toHaveBeenCalledTimes(1);
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
      path: workspacePath,
      text: "Сделай план реализации",
    });
  });

  it("routes the draft to the window that already owns the project", async () => {
    const workspacePath = createTempWorkspace();
    const firstWindow = createMockWindow(31);
    const ownerWindow = createMockWindow(32);
    electronMocks.getFocusedWindow.mockReturnValue(firstWindow);
    electronMocks.getAllWindows.mockReturnValue([firstWindow, ownerWindow]);
    const { deliverPendingDeepLink, handleTaskNewDeepLink, setTaskDraftOwnerWindowResolver } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(firstWindow.webContents);
    deliverPendingDeepLink(ownerWindow.webContents);
    firstWindow.webContents.send.mockClear();
    ownerWindow.webContents.send.mockClear();
    setTaskDraftOwnerWindowResolver((path) => (path === workspacePath ? ownerWindow : null));

    await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "plan" }),
      createLogger(),
      { resolveApplicationWindow: () => firstWindow as never },
    );

    expect(firstWindow.webContents.send).not.toHaveBeenCalled();
    expect(ownerWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
      path: workspacePath,
      text: "plan",
    });
    expect(ownerWindow.focus).toHaveBeenCalled();
  });

  it("reads promptFile in main and sends its text", async () => {
    const workspacePath = createTempWorkspace();
    const planFile = join(workspacePath, "plan.md");
    writeFileSync(planFile, "# План\nШаг 1");
    const targetWindow = createMockWindow(22);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { promptFile: planFile }),
      createLogger(),
    );

    expect(targetWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
      path: workspacePath,
      text: "# План\nШаг 1",
    });
  });

  it("caches for a window that is not ready and delivers after renderer ready", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(23);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    await handleTaskNewDeepLink(buildTaskNewUrl(workspacePath, { prompt: "cold" }), createLogger());
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();

    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
      path: workspacePath,
      text: "cold",
    });
  });

  it("with no window at all, caches unbound and the first ready window receives it", async () => {
    const workspacePath = createTempWorkspace();
    const firstWindow = createMockWindow(24);
    electronMocks.getFocusedWindow.mockReturnValue(null);
    electronMocks.getAllWindows.mockReturnValue([]);
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "first" }),
      createLogger(),
    );
    deliverPendingDeepLink(firstWindow.webContents);

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
      path: workspacePath,
      text: "first",
    });
  });

  it("a pending draft bound to a window is only delivered to that window and cleared on close", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(25);
    const otherWindow = createMockWindow(26);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow, otherWindow]);
    const { clearOAuthRoutesForWindow, deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "bound" }),
      createLogger(),
    );
    deliverPendingDeepLink(otherWindow.webContents);
    expect(otherWindow.webContents.send).not.toHaveBeenCalled();

    clearOAuthRoutesForWindow(targetWindow.webContents.id);
    deliverPendingDeepLink(targetWindow.webContents);
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("does not send or cache when the user cancels the confirmation", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(27);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    electronMocks.showMessageBoxSync.mockReturnValue(1);
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");

    await handleTaskNewDeepLink(buildTaskNewUrl(workspacePath, { prompt: "no" }), createLogger());
    deliverPendingDeepLink(targetWindow.webContents);

    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("rejects UNC paths before any filesystem probe or dialog", async () => {
    const targetWindow = createMockWindow(28);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { handleTaskNewDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");
    fsMocks.statSync.mockClear();

    const handled = await handleTaskNewDeepLink(
      buildTaskNewUrl("\\\\server\\share\\project", { prompt: "x" }),
      createLogger(),
    );

    expect(handled).toBe(false);
    expect(fsMocks.statSync).not.toHaveBeenCalled();
    expect(electronMocks.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("rejects UNC promptFile, missing directory, and both/neither prompt params without a dialog", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(29);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { handleTaskNewDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");
    const logger = createLogger();

    await expect(
      handleTaskNewDeepLink(
        buildTaskNewUrl(workspacePath, { promptFile: "\\\\server\\share\\plan.md" }),
        logger,
      ),
    ).resolves.toBe(false);
    await expect(
      handleTaskNewDeepLink(
        buildTaskNewUrl(join(workspacePath, "missing"), { prompt: "x" }),
        logger,
      ),
    ).resolves.toBe(false);
    await expect(
      handleTaskNewDeepLink(
        buildTaskNewUrl(workspacePath, { prompt: "x", promptFile: join(workspacePath, "p.md") }),
        logger,
      ),
    ).resolves.toBe(false);
    await expect(handleTaskNewDeepLink(buildTaskNewUrl(workspacePath, {}), logger)).resolves.toBe(
      false,
    );

    expect(electronMocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("rejects a promptFile outside the project without a dialog", async () => {
    const workspacePath = createTempWorkspace();
    const elsewhere = createTempWorkspace();
    const planFile = join(elsewhere, "plan.md");
    writeFileSync(planFile, "secret");
    const { handleTaskNewDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");

    await expect(
      handleTaskNewDeepLink(
        buildTaskNewUrl(workspacePath, { promptFile: planFile }),
        createLogger(),
      ),
    ).resolves.toBe(false);
    expect(electronMocks.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("never logs the prompt text", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(30);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const logger = createLogger();
    const { deliverPendingDeepLink, handleTaskNewDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents);

    await handleTaskNewDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "super-secret-token-text" }),
      logger,
    );

    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(
      "super-secret-token-text",
    );
  });

  it("handleDeepLink dispatches task/new, honoring the force-update gate", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(31);
    electronMocks.getFocusedWindow.mockReturnValue(targetWindow);
    electronMocks.getAllWindows.mockReturnValue([targetWindow]);
    const { deliverPendingDeepLink, handleDeepLink } =
      await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents);
    targetWindow.webContents.send.mockClear();

    const blocked = handleDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "gated" }),
      createLogger(),
      {
        canOpenWorkspace: () => false,
      },
    );
    expect(blocked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();

    const handled = handleDeepLink(
      buildTaskNewUrl(workspacePath, { prompt: "go" }),
      createLogger(),
    );
    expect(handled).toBe(true);
    await vi.waitFor(() =>
      expect(targetWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.OpenTaskDraft, {
        path: workspacePath,
        text: "go",
      }),
    );
  });
});

describe("task draft dialog copy", () => {
  it("is localized for every supported locale and embeds path and preview", async () => {
    const { resolveTaskDraftDialogCopy } = await import("../src/main/desktopTaskDraftDeepLink.js");

    for (const locale of ["zh-CN", "en-US", "uk-UA"] as const) {
      const copy = resolveTaskDraftDialogCopy(locale);
      expect(copy.buttons).toHaveLength(2);
      const detail = copy.detail("/tmp/project", "PREVIEW-TEXT");
      expect(detail).toContain("/tmp/project");
      expect(detail).toContain("PREVIEW-TEXT");
    }
  });
});
