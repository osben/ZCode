import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ISettingService } from "../src/setting/setting.js";

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
    await expect(service.get()).resolves.toMatchObject({
      locale: "uk-UA",
      localePreference: "uk-UA",
    });
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
