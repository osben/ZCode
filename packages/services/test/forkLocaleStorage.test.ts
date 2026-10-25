import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ISettingService } from "../src/setting/setting.js";

// Fault and interleaving hooks. Each is inert unless a test arms it.
const hooks = vi.hoisted(() => ({
  gateNextForkWrite: undefined as undefined | { reached: () => void; release: Promise<void> },
  failSharedWrite: false,
}));

vi.mock("../src/setting/forkSettingsSidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/setting/forkSettingsSidecar.js")>();
  return {
    ...actual,
    updateForkSettings: async (...args: Parameters<typeof actual.updateForkSettings>) => {
      const gate = hooks.gateNextForkWrite;
      if (gate) {
        // Hold the fork write open so a second service instance can run its update in the window.
        hooks.gateNextForkWrite = undefined;
        gate.reached();
        await gate.release;
      }
      return actual.updateForkSettings(...args);
    },
  };
});

vi.mock("../src/fs/atomicFileUtils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fs/atomicFileUtils.js")>();
  return {
    ...actual,
    atomicWriteText: async (...args: Parameters<typeof actual.atomicWriteText>) => {
      // Simulates a Windows EPERM/EBUSY rename failure on the shared setting.json only.
      if (hooks.failSharedWrite && args[0].endsWith(join(".zcode", "v2", "setting.json"))) {
        throw Object.assign(new Error("EPERM: rename failed"), { code: "EPERM" });
      }
      return actual.atomicWriteText(...args);
    },
  };
});

// Literal copies of the upstream app's enums (the upstream build that shares setting.json).
const upstreamLocaleEnum = z.enum(["zh-CN", "en-US"]);
const upstreamLocalePreferenceEnum = z.enum(["system", "zh-CN", "en-US"]);

const originalHome = process.env.HOME;
const originalDesktopHome = process.env.ZCODE_DESKTOP_HOME_DIR;
const originalZCodeEnv = process.env.ZCODE_ENV;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-fork-locale-"));
  tempHomes.push(home);
  return home;
}

function settingsFile(home: string): string {
  return join(home, ".zcode", "v2", "setting.json");
}

function forkSettingsFile(home: string): string {
  return join(home, ".zcode", "v2", "fork-settings.json");
}

function readRaw(path: string): string {
  return readFileSync(path, "utf-8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readRaw(path)) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

async function createServiceInHome(home: string): Promise<ISettingService> {
  process.env.HOME = home;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  vi.resetModules();
  const mod = await import("../src/setting/settingService.js");
  return mod.createSettingService();
}

function expectUpstreamValid(file: Record<string, unknown>): void {
  if ("locale" in file) {
    expect(upstreamLocaleEnum.safeParse(file.locale).success).toBe(true);
  }
  if ("localePreference" in file) {
    expect(upstreamLocalePreferenceEnum.safeParse(file.localePreference).success).toBe(true);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDesktopHome === undefined) delete process.env.ZCODE_DESKTOP_HOME_DIR;
  else process.env.ZCODE_DESKTOP_HOME_DIR = originalDesktopHome;
  if (originalZCodeEnv === undefined) delete process.env.ZCODE_ENV;
  else process.env.ZCODE_ENV = originalZCodeEnv;
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("fork locale storage (ISSUE-045)", () => {
  it("picking Ukrainian keeps setting.json upstream-valid with the same key set", async () => {
    const home = makeTempHome();
    const service = await createServiceInHome(home);
    await service.update({ locale: "zh-CN", localePreference: "zh-CN" });
    const keysBefore = Object.keys(readJson(settingsFile(home))).sort();

    await service.update({ locale: "uk-UA", localePreference: "uk-UA" });

    const main = readJson(settingsFile(home));
    expect(Object.keys(main).sort()).toEqual(keysBefore);
    expectUpstreamValid(main);
    expect(readRaw(settingsFile(home))).not.toContain("uk-UA");
    expect(readJson(forkSettingsFile(home))).toMatchObject({
      localePreferenceOverride: "uk-UA",
      localeOverride: "uk-UA",
    });
    const effective = await service.get();
    expect(effective).toMatchObject({ locale: "uk-UA", localePreference: "uk-UA" });
    // Overrides are applied to the effective view and never exposed as settings fields.
    expect(effective).not.toHaveProperty("localeOverride");
    expect(effective).not.toHaveProperty("localePreferenceOverride");
  });

  it("keeps the Ukrainian choice after a restart", async () => {
    const home = makeTempHome();
    const first = await createServiceInHome(home);
    await first.update({ locale: "uk-UA", localePreference: "uk-UA" });

    const restarted = await createServiceInHome(home);

    await expect(restarted.get()).resolves.toMatchObject({
      locale: "uk-UA",
      localePreference: "uk-UA",
    });
  });

  it("clears the fork override when the user picks English", async () => {
    const home = makeTempHome();
    const service = await createServiceInHome(home);
    await service.update({ locale: "uk-UA", localePreference: "uk-UA" });

    await service.update({ locale: "en-US", localePreference: "en-US" });

    const fork = readJson(forkSettingsFile(home));
    expect(fork).not.toHaveProperty("localePreferenceOverride");
    expect(fork).not.toHaveProperty("localeOverride");
    expect(readJson(settingsFile(home))).toMatchObject({
      locale: "en-US",
      localePreference: "en-US",
    });
    await expect(service.get()).resolves.toMatchObject({
      locale: "en-US",
      localePreference: "en-US",
    });
  });

  it("migrates a legacy uk-UA file once and leaves unrelated keys untouched", async () => {
    const home = makeTempHome();
    const seeded = await createServiceInHome(home);
    await seeded.update({
      locale: "zh-CN",
      localePreference: "zh-CN",
      terminalFontFamily: "Menlo",
    });
    const base = readJson(settingsFile(home));
    // Simulate the file the upstream build left behind: the two locale keys are uk-UA and every
    // other key stays exactly as it was.
    writeJson(settingsFile(home), { ...base, locale: "uk-UA", localePreference: "uk-UA" });
    const legacyRaw = readRaw(settingsFile(home));

    const service = await createServiceInHome(home);
    await expect(service.get()).resolves.toMatchObject({
      locale: "uk-UA",
      localePreference: "uk-UA",
      terminalFontFamily: "Menlo",
    });

    const migrated = readJson(settingsFile(home));
    expectUpstreamValid(migrated);
    const { locale: _l, localePreference: _p, ...restBefore } = JSON.parse(legacyRaw);
    const { locale: _l2, localePreference: _p2, ...restAfter } = migrated;
    expect(restAfter).toEqual(restBefore);
    expect(readJson(forkSettingsFile(home))).toMatchObject({
      localePreferenceOverride: "uk-UA",
      localeOverride: "uk-UA",
    });

    // Idempotent: a second read changes no bytes.
    const afterFirst = readRaw(settingsFile(home));
    await service.get();
    expect(readRaw(settingsFile(home))).toBe(afterFirst);
  });

  it("keeps the system preference when only the resolved locale was Ukrainian", async () => {
    const home = makeTempHome();
    const seeded = await createServiceInHome(home);
    await seeded.update({ locale: "zh-CN", localePreference: "system" });
    writeJson(settingsFile(home), {
      ...readJson(settingsFile(home)),
      locale: "uk-UA",
      localePreference: "system",
    });

    const service = await createServiceInHome(home);

    await expect(service.get()).resolves.toMatchObject({
      locale: "uk-UA",
      localePreference: "system",
    });
    const main = readJson(settingsFile(home));
    expectUpstreamValid(main);
    expect(main.localePreference).toBe("system");
    expect(readJson(forkSettingsFile(home))).toMatchObject({ localeOverride: "uk-UA" });
    expect(readJson(forkSettingsFile(home))).not.toHaveProperty("localePreferenceOverride");
  });

  it("migrates a legacy uk-UA file before an unrelated update, so the update cannot persist uk-UA", async () => {
    const home = makeTempHome();
    const seeded = await createServiceInHome(home);
    await seeded.update({ locale: "zh-CN", localePreference: "zh-CN" });
    writeJson(settingsFile(home), {
      ...readJson(settingsFile(home)),
      locale: "uk-UA",
      localePreference: "uk-UA",
    });

    const service = await createServiceInHome(home);
    await service.update({ terminalFontFamily: "Menlo" });

    const main = readJson(settingsFile(home));
    expectUpstreamValid(main);
    expect(main.terminalFontFamily).toBe("Menlo");
    await expect(service.get()).resolves.toMatchObject({
      locale: "uk-UA",
      localePreference: "uk-UA",
      terminalFontFamily: "Menlo",
    });
  });

  it("serializes shared and fork writes across instances so the last update wins", async () => {
    const home = makeTempHome();
    const first = await createServiceInHome(home);
    await first.update({ locale: "zh-CN", localePreference: "zh-CN" });
    const mod = await import("../src/setting/settingService.js");
    const second = mod.createSettingService();

    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.gateNextForkWrite = { reached, release: releasePromise };

    const ukUpdate = first.update({ locale: "uk-UA", localePreference: "uk-UA" });
    await reachedPromise;
    // "en-US" is the last user choice. It must not be overwritten by the earlier uk-UA fork write.
    const enUpdate = second.update({ locale: "en-US", localePreference: "en-US" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([ukUpdate, enUpdate]);

    const fresh = await createServiceInHome(home);
    await expect(fresh.get()).resolves.toMatchObject({
      locale: "en-US",
      localePreference: "en-US",
    });
    expect(readJson(forkSettingsFile(home))).not.toHaveProperty("localePreferenceOverride");
    expect(readJson(forkSettingsFile(home))).not.toHaveProperty("localeOverride");
  });

  it("keeps get() working when the shared rewrite of a legacy uk-UA file fails", async () => {
    const home = makeTempHome();
    const seeded = await createServiceInHome(home);
    await seeded.update({ locale: "zh-CN", localePreference: "zh-CN" });
    writeJson(settingsFile(home), {
      ...readJson(settingsFile(home)),
      locale: "uk-UA",
      localePreference: "uk-UA",
    });

    const service = await createServiceInHome(home);
    hooks.failSharedWrite = true;
    try {
      // The fork override is written before the shared rewrite, so the choice survives the failure.
      await expect(service.get()).resolves.toMatchObject({
        locale: "uk-UA",
        localePreference: "uk-UA",
      });
      expect(readJson(forkSettingsFile(home))).toMatchObject({
        localePreferenceOverride: "uk-UA",
        localeOverride: "uk-UA",
      });
    } finally {
      hooks.failSharedWrite = false;
    }

    // The next read finishes the one-time rewrite.
    await service.get();
    expectUpstreamValid(readJson(settingsFile(home)));
  });

  it("rejects an update that cannot finish the legacy migration, without clobbering the file", async () => {
    const home = makeTempHome();
    const seeded = await createServiceInHome(home);
    await seeded.update({ locale: "zh-CN", localePreference: "zh-CN" });
    writeJson(settingsFile(home), {
      ...readJson(settingsFile(home)),
      locale: "uk-UA",
      localePreference: "uk-UA",
    });

    const service = await createServiceInHome(home);
    hooks.failSharedWrite = true;
    try {
      await expect(service.update({ terminalFontFamily: "Menlo" })).rejects.toThrow();
    } finally {
      hooks.failSharedWrite = false;
    }

    // A merge over the still-uk-UA file would have written zh-CN defaults over the choice.
    expect(readJson(settingsFile(home)).locale).toBe("uk-UA");
    await service.update({ terminalFontFamily: "Menlo" });
    expectUpstreamValid(readJson(settingsFile(home)));
  });

  it("never persists a value outside the upstream enums for any locale input", async () => {
    const home = makeTempHome();
    const service = await createServiceInHome(home);
    const inputs = [
      { locale: "zh-CN", localePreference: "system" },
      { locale: "en-US", localePreference: "en-US" },
      { locale: "uk-UA", localePreference: "uk-UA" },
      { locale: "uk-UA", localePreference: "system" },
      { locale: "zh-CN", localePreference: "zh-CN" },
    ] as const;

    for (const input of inputs) {
      await service.update({ ...input });
      expectUpstreamValid(readJson(settingsFile(home)));
    }
    expect(existsSync(forkSettingsFile(home))).toBe(true);
  });
});
