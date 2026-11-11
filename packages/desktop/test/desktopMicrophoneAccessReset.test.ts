// @vitest-environment node

import { PlatformChannels } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  app: { isPackaged: true },
  handle: vi.fn(),
  openExternal: vi.fn(),
  getMediaAccessStatus: vi.fn(),
  askForMediaAccess: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: h.app,
  ipcMain: { handle: h.handle },
  shell: { openExternal: h.openExternal },
  systemPreferences: {
    getMediaAccessStatus: h.getMediaAccessStatus,
    askForMediaAccess: h.askForMediaAccess,
  },
}));

vi.mock("node:child_process", () => ({ execFile: h.execFile }));

import {
  registerDesktopMicrophoneIpcHandlers,
  resetMicrophoneAccess,
} from "../src/main/microphone-access/desktopMicrophoneAccess.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Simulates PlistBuddy (bundle id) and tccutil; `failTccutil` makes the reset command fail. */
function mockCommands(options: { bundleId?: string; failTccutil?: boolean } = {}) {
  h.execFile.mockImplementation(
    (file: string, _args: string[], callback: (error: Error | null, stdout: string) => void) => {
      if (file === "/usr/libexec/PlistBuddy") {
        callback(null, `${options.bundleId ?? "com.zcode.app"}\n`);
        return;
      }
      if (options.failTccutil) callback(new Error("tccutil exited 1"), "");
      else callback(null, "");
    },
  );
}

function tccutilCalls() {
  return h.execFile.mock.calls.filter(([file]) => file === "/usr/bin/tccutil");
}

const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.app.isPackaged = true;
  setPlatform("darwin");
  mockCommands();
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("resetMicrophoneAccess", () => {
  it("is macOS only and never touches TCC elsewhere", async () => {
    setPlatform("win32");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("failed");
    expect(h.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("returns granted without clearing anything when access is already granted", async () => {
    h.getMediaAccessStatus.mockReturnValue("granted");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("granted");
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("returns failed for a restricted (MDM-managed) decision", async () => {
    h.getMediaAccessStatus.mockReturnValue("restricted");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("failed");
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("packaged build: resets this bundle's TCC entry, then asks again and grants", async () => {
    h.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValueOnce("not-determined");
    h.askForMediaAccess.mockResolvedValue(true);

    await expect(resetMicrophoneAccess(logger)).resolves.toBe("granted");

    expect(tccutilCalls()).toEqual([
      ["/usr/bin/tccutil", ["reset", "Microphone", "com.zcode.app"], expect.any(Function)],
    ]);
    expect(h.askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("packaged build: reports denied when the new system prompt is refused", async () => {
    h.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValueOnce("not-determined");
    h.askForMediaAccess.mockResolvedValue(false);
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("denied");
  });

  it("packaged build: asks restart-required when the reset did not make the status not-determined", async () => {
    h.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValueOnce("denied");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("restart-required");
    expect(h.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("dev build: skips tccutil so it cannot clear another app's entry", async () => {
    h.app.isPackaged = false;
    h.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValueOnce("denied");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("restart-required");
    expect(tccutilCalls()).toEqual([]);
  });

  it("returns failed and logs a warning when tccutil fails", async () => {
    mockCommands({ failTccutil: true });
    h.getMediaAccessStatus.mockReturnValue("denied");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "[voice-input] reset microphone access failed error=tccutil exited 1",
    );
    expect(h.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("refuses a bundle id that is not a plain reverse-DNS name before calling tccutil", async () => {
    mockCommands({ bundleId: "com.zcode.app; rm -rf ~" });
    h.getMediaAccessStatus.mockReturnValue("denied");
    await expect(resetMicrophoneAccess(logger)).resolves.toBe("failed");
    expect(tccutilCalls()).toEqual([]);
  });
});

describe("reset IPC handler", () => {
  function getResetHandler() {
    registerDesktopMicrophoneIpcHandlers(logger);
    const entry = h.handle.mock.calls.find(
      ([channel]) => channel === PlatformChannels.ResetMicrophoneAccess,
    );
    if (!entry) throw new Error("reset handler not registered");
    return entry[1] as () => Promise<string>;
  }

  it("registers the reset channel next to the access and settings channels", () => {
    registerDesktopMicrophoneIpcHandlers(logger);
    const channels = h.handle.mock.calls.map(([channel]) => channel);
    expect(channels).toEqual(
      expect.arrayContaining([
        PlatformChannels.MicrophoneAccess,
        PlatformChannels.ResetMicrophoneAccess,
        PlatformChannels.OpenMicrophoneSettings,
      ]),
    );
    expect(PlatformChannels.ResetMicrophoneAccess).toBe("zcode:reset-microphone-access");
  });

  it("shares one in-flight reset between concurrent calls so tccutil runs once", async () => {
    h.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValueOnce("denied");
    const handler = getResetHandler();

    const [first, second] = await Promise.all([handler(), handler()]);

    expect(first).toBe("restart-required");
    expect(second).toBe("restart-required");
    expect(tccutilCalls()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[voice-input] reset microphone access result=restart-required packaged=true",
    );
  });

  it("starts a new reset after the previous one settled", async () => {
    h.getMediaAccessStatus.mockReturnValue("denied");
    const handler = getResetHandler();
    await handler();
    await handler();
    expect(tccutilCalls()).toHaveLength(2);
  });
});
