import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const { appOn, ipcHandle } = vi.hoisted(() => ({
  appOn: vi.fn(),
  ipcHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: appOn },
  ipcMain: { handle: ipcHandle },
}));

import { registerDesktopDictationSystemAudioIpc } from "../src/main/desktopDictationSystemAudio.js";

const MACOS_READ = ["-e", "output muted of (get volume settings)"];
const MACOS_MUTE = ["-e", "set volume output muted true"];
const MACOS_UNMUTE = ["-e", "set volume output muted false"];

/** Minimal WebContents double: records the per-owner listeners so tests can emit them. */
let nextSenderId = 1;
function createSender(): WebContents & { emit(event: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  const sender = {
    id: nextSenderId++,
    once(event: string, handler: () => void) {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(handler);
      listeners.set(event, set);
      return sender;
    },
    removeListener(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler);
      return sender;
    },
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  };
  return sender as WebContents & { emit(event: string): void };
}

function register(options: {
  platform: NodeJS.Platform;
  execAsync?: (file: string, args: string[]) => Promise<string>;
  execSync?: (file: string, args: string[]) => string;
}) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  registerDesktopDictationSystemAudioIpc({
    logger,
    platform: options.platform,
    execAsync: options.execAsync ?? (async () => ""),
    execSync: options.execSync ?? (() => ""),
  });
  expect(ipcHandle).toHaveBeenCalledWith("zcode:set-dictation-system-mute", expect.any(Function));
  const handler = ipcHandle.mock.lastCall![1] as (
    event: { sender: WebContents },
    payload: { active: boolean },
  ) => Promise<void>;
  return { logger, handler };
}

describe("desktop dictation system audio mute", () => {
  it("mutes via osascript on darwin and restores on release", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockResolvedValue("false\n");
    const { handler } = register({ platform: "darwin", execAsync });
    const sender = createSender();

    await handler({ sender }, { active: true });
    await handler({ sender }, { active: false });

    expect(execAsync.mock.calls).toEqual([
      ["osascript", MACOS_READ],
      ["osascript", MACOS_MUTE],
      ["osascript", MACOS_UNMUTE],
    ]);
  });

  it("keeps an already muted output muted without unmuting it on release", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockResolvedValue("true\n");
    const { logger, handler } = register({ platform: "darwin", execAsync });
    const sender = createSender();

    await handler({ sender }, { active: true });
    await handler({ sender }, { active: false });

    expect(execAsync).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[dictation-audio] output kept muted (already muted) for dictation",
    );
  });

  it("skips muting when reading the output state fails and still releases cleanly", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(new Error("osascript denied"));
    const { logger, handler } = register({ platform: "darwin", execAsync });
    const sender = createSender();

    await expect(handler({ sender }, { active: true })).resolves.toBeUndefined();
    await expect(handler({ sender }, { active: false })).resolves.toBeUndefined();

    expect(execAsync).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to read output mute state"),
    );
  });

  it("falls back from wpctl to pactl on linux with explicit mute verbs", async () => {
    const execAsync = vi.fn<(file: string, args: string[]) => Promise<string>>();
    execAsync.mockImplementation(async (file: string, args: string[]) => {
      if (file === "wpctl") throw new Error("spawn wpctl ENOENT");
      if (file === "pactl" && args[0] === "get-sink-mute") return "Mute: no\n";
      return "";
    });
    const { handler } = register({ platform: "linux", execAsync });
    const sender = createSender();

    await handler({ sender }, { active: true });
    await handler({ sender }, { active: false });

    // The first pactl call is the tool probe; the second is the actual state read.
    expect(execAsync.mock.calls.filter(([file]) => file === "pactl")).toEqual([
      ["pactl", ["get-sink-mute", "@DEFAULT_SINK@"]],
      ["pactl", ["get-sink-mute", "@DEFAULT_SINK@"]],
      ["pactl", ["set-sink-mute", "@DEFAULT_SINK@", "1"]],
      ["pactl", ["set-sink-mute", "@DEFAULT_SINK@", "0"]],
    ]);
  });

  it("no-ops on windows with a warn log", async () => {
    const execAsync = vi.fn<(file: string, args: string[]) => Promise<string>>();
    const { logger, handler } = register({ platform: "win32", execAsync });
    const sender = createSender();

    expect(handler({ sender }, { active: true })).toBeUndefined();

    expect(execAsync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("win32"));
  });

  it("restores the output synchronously on before-quit", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockResolvedValue("false\n");
    const execSync = vi.fn<(file: string, args: string[]) => string>(() => "");
    const { handler } = register({ platform: "darwin", execAsync, execSync });
    const sender = createSender();

    await handler({ sender }, { active: true });

    // Take the handler from this registration: earlier tests registered their own closures.
    const quitHandlers = appOn.mock.calls
      .filter(([event]) => event === "before-quit")
      .map(([, handler]) => handler) as Array<() => void>;
    const quitHandler = quitHandlers.at(-1)!;
    expect(quitHandler).toBeTypeOf("function");
    quitHandler();

    expect(execSync).toHaveBeenCalledWith("osascript", MACOS_UNMUTE);
  });

  it("releases when the owning renderer is destroyed", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockResolvedValue("false\n");
    const { handler } = register({ platform: "darwin", execAsync });
    const sender = createSender();

    await handler({ sender }, { active: true });
    sender.emit("destroyed");

    await vi.waitFor(() => {
      expect(execAsync).toHaveBeenCalledWith("osascript", MACOS_UNMUTE);
    });
  });

  it("keeps the mute while another recording window still owns it", async () => {
    const execAsync = vi
      .fn<(file: string, args: string[]) => Promise<string>>()
      .mockResolvedValueOnce("false\n")
      .mockResolvedValue("true\n");
    const { handler } = register({ platform: "darwin", execAsync });
    const senderA = createSender();
    const senderB = createSender();

    await handler({ sender: senderA }, { active: true });
    await handler({ sender: senderB }, { active: true });
    await handler({ sender: senderA }, { active: false });
    expect(execAsync).not.toHaveBeenCalledWith("osascript", MACOS_UNMUTE);

    await handler({ sender: senderB }, { active: false });
    await vi.waitFor(() => {
      expect(execAsync).toHaveBeenCalledWith("osascript", MACOS_UNMUTE);
    });
  });

  it("ignores malformed payloads", async () => {
    const execAsync = vi.fn<(file: string, args: string[]) => Promise<string>>();
    const { handler } = register({ platform: "darwin", execAsync });

    expect(
      handler({ sender: createSender() }, undefined as unknown as { active: boolean }),
    ).toBeUndefined();
    expect(
      handler({ sender: createSender() }, { active: "yes" as unknown as boolean }),
    ).toBeUndefined();

    expect(execAsync).not.toHaveBeenCalled();
  });
});
