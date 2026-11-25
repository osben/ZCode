import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WaitOptions = { timeoutMsg?: string };

let home: string;
let rendererLocale: string;
let settingsFile: string;

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".zcode", "v2"), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(settings), "utf-8");
}

// Minimal WDIO stand-in: execute runs the helper's callback against a fake renderer whose
// test actions apply setLocale at once, and waitUntil polls a few times.
function stubBrowser(onPoll?: (attempt: number) => Promise<void>): void {
  vi.stubGlobal("window", {
    __testActions: {
      getLocale: () => rendererLocale,
      setLocale: (next: string) => {
        rendererLocale = next;
      },
    },
  });
  vi.stubGlobal("browser", {
    execute: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    waitUntil: async (condition: () => Promise<boolean>, options: WaitOptions = {}) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await onPoll?.(attempt);
        if (await condition()) return true;
      }
      throw new Error(options.timeoutMsg ?? "waitUntil timed out");
    },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "e2e-pin-locale-"));
  settingsFile = join(home, ".zcode", "v2", "setting.json");
  rendererLocale = "en-US";
  vi.stubEnv("ZCODE_E2E_HOME_DIR", home);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("pinE2ELocale", () => {
  it("does not return while setting.json still holds the old language", async () => {
    await writeSettings({ locale: "en-US", uiLocale: "en-US" });
    stubBrowser();
    const { pinE2ELocale } = await import("#e2e/helpers/desktop-app");

    await expect(pinE2ELocale("zh-CN")).rejects.toThrow(/zh-CN/);
  });

  it("returns once the renderer and setting.json both hold the new language", async () => {
    await writeSettings({ locale: "en-US", uiLocale: "en-US" });
    stubBrowser(async (attempt) => {
      if (attempt === 2) await writeSettings({ locale: "zh-CN", uiLocale: "zh-CN" });
    });
    const { pinE2ELocale } = await import("#e2e/helpers/desktop-app");

    await expect(pinE2ELocale("zh-CN")).resolves.toBeUndefined();
  });

  it("waits while the new uiLocale field disagrees with the legacy locale field", async () => {
    // resolvePersistedUiLocale trusts the legacy field when the two disagree, so the saved
    // language is still en-US here even though uiLocale already says zh-CN.
    await writeSettings({ locale: "en-US", uiLocale: "zh-CN" });
    stubBrowser();
    const { pinE2ELocale } = await import("#e2e/helpers/desktop-app");

    await expect(pinE2ELocale("zh-CN")).rejects.toThrow(/setting\.json/);
    expect(rendererLocale).toBe("zh-CN");
  });

  it("returns once the legacy locale field catches up with uiLocale", async () => {
    await writeSettings({ locale: "en-US", uiLocale: "zh-CN" });
    stubBrowser(async (attempt) => {
      if (attempt === 2) await writeSettings({ locale: "zh-CN", uiLocale: "zh-CN" });
    });
    const { pinE2ELocale } = await import("#e2e/helpers/desktop-app");

    await expect(pinE2ELocale("zh-CN")).resolves.toBeUndefined();
  });

  it("fails when the renderer never applies setLocale", async () => {
    await writeSettings({ locale: "zh-CN", uiLocale: "zh-CN" });
    stubBrowser();
    vi.stubGlobal("window", {
      __testActions: { getLocale: () => rendererLocale, setLocale: () => {} },
    });
    const { pinE2ELocale } = await import("#e2e/helpers/desktop-app");

    await expect(pinE2ELocale("zh-CN")).rejects.toThrow(/zh-CN/);
    expect(rendererLocale).toBe("en-US");
  });
});
