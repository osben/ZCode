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

// Minimal WDIO stand-in: the renderer applies setLocale at once, and waitUntil polls a few times.
function stubBrowser(onPoll?: (attempt: number) => Promise<void>): void {
  vi.stubGlobal("browser", {
    execute: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
      if (arg !== undefined) {
        rendererLocale = arg as string;
        return undefined;
      }
      return rendererLocale;
    },
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
});
