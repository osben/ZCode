import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, buildRemoteWorkspaceIdentity } from "@zcode/shared";

const electronMocks = vi.hoisted(() => ({
  fromId: vi.fn(),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
  appShow: vi.fn(),
}));

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
    fromId: electronMocks.fromId,
    getFocusedWindow: electronMocks.getFocusedWindow,
    getAllWindows: electronMocks.getAllWindows,
  },
  dialog: {
    showMessageBoxSync: vi.fn(() => 0),
  },
}));

const tempDirs: string[] = [];

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-web-rc-open-"));
  tempDirs.push(dir);
  return dir;
}

function createMockWindow(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      id,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  vi.resetModules();
  electronMocks.fromId.mockReset();
  electronMocks.getFocusedWindow.mockReset();
  electronMocks.getAllWindows.mockReset();
  electronMocks.appShow.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openWebRemoteControlWorkspaceInWindow", () => {
  it("fails closed for a remote worktree identity instead of opening its path as a local workspace", async () => {
    // The path exists locally, so the path-only local open would succeed without the guard.
    const workspacePath = createTempWorkspace();
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, {
      kind: "ssh",
      host: "dev.internal",
      port: 22,
      username: "developer",
    });
    const targetWindow = createMockWindow(7);
    electronMocks.fromId.mockReturnValue(targetWindow);
    const logger = createLogger();
    const { openWebRemoteControlWorkspaceInWindow } =
      await import("../src/main/webRemoteControlWorkspaceOpen.js");
    const { deliverPendingDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents as never);
    targetWindow.webContents.send.mockClear();

    await expect(
      openWebRemoteControlWorkspaceInWindow(7, { workspacePath, workspaceIdentity }, logger),
    ).rejects.toThrow("cannot open a remote workspace identity");

    expect(electronMocks.fromId).not.toHaveBeenCalled();
    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[web-remote-control] remote workspace open rejected: identity is not routable",
      { workspacePath },
    );
  });

  it("fails closed for an unparseable remote identity", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(7);
    electronMocks.fromId.mockReturnValue(targetWindow);
    const { openWebRemoteControlWorkspaceInWindow } =
      await import("../src/main/webRemoteControlWorkspaceOpen.js");

    await expect(
      openWebRemoteControlWorkspaceInWindow(
        7,
        { workspacePath, workspaceIdentity: "remote:ssh:broken" },
        createLogger(),
      ),
    ).rejects.toThrow("cannot open a remote workspace identity");

    expect(targetWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("keeps the local path-only open for a workspace without a remote identity", async () => {
    const workspacePath = createTempWorkspace();
    const targetWindow = createMockWindow(7);
    electronMocks.fromId.mockReturnValue(targetWindow);
    const { openWebRemoteControlWorkspaceInWindow } =
      await import("../src/main/webRemoteControlWorkspaceOpen.js");
    const { deliverPendingDeepLink } = await import("../src/main/desktopOAuthDeepLink.js");
    deliverPendingDeepLink(targetWindow.webContents as never);
    targetWindow.webContents.send.mockClear();

    await expect(
      openWebRemoteControlWorkspaceInWindow(7, { workspacePath }, createLogger()),
    ).resolves.toBeUndefined();

    expect(targetWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenWorkspacePath,
      workspacePath,
    );
  });
});
