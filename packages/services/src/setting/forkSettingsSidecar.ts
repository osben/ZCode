import { mkdir, readFile } from "node:fs/promises";
import type { ForkAppSettings, ForkAppSettingsStored } from "@zcode/shared";
import {
  forkAppSettingsPatchSchema,
  forkAppSettingsSchema,
  forkAppSettingsStoredSchema,
  formatLogPrefix,
  formatZodError,
} from "@zcode/shared";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { getForkSettingsFile, getSettingsDir } from "./settingsPaths.js";

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("forkSettings", process.pid), ...args);

function debugLog(...args: unknown[]) {
  // NODE_ENV inherited from the user's shell can mislead the service-layer debug switch; use ZCODE_RUNTIME_ENV consistently.
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("forkSettings", process.pid), ...args);
}

/** Same stale-write protection writeSettings() uses for the main file: an expired queue turn must not rename late. */
export interface ForkSettingsWriteGuards {
  shouldCommit: () => boolean;
}

/** Read the raw sidecar payload, or undefined when the file is missing or unreadable. */
async function readRawForkSettings(): Promise<unknown> {
  const forkSettingsFile = getForkSettingsFile();
  try {
    const raw = await readFile(forkSettingsFile, "utf-8");
    try {
      return JSON.parse(raw);
    } catch (parseError) {
      // The sidecar is written only by this module with atomic writes, so a torn read should not
      // happen; a broken file (manual edit) degrades to defaults instead of failing every read.
      log("fork settings json parse failed, using defaults. error:", parseError);
      return undefined;
    }
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }
    log("fork settings read failed, using defaults. error:", err);
    return undefined;
  }
}

/**
 * Effective sidecar view for consumers: stored values plus materialized defaults. Defaults exist
 * only in memory — they are never written back to the file, so a future default change reaches
 * everyone who never explicitly set the setting.
 */
export async function readForkSettings(): Promise<ForkAppSettings> {
  const result = forkAppSettingsSchema.safeParse((await readRawForkSettings()) ?? {});
  if (!result.success) {
    log(
      "fork settings read failed schema validation, using defaults. error:",
      formatZodError(result.error),
    );
    return forkAppSettingsSchema.parse({});
  }
  debugLog("fork settings read result:", JSON.stringify(result.data));
  return result.data;
}

/** Stored sidecar view: only explicitly set keys, no materialized defaults. Used for write merges. */
export async function readStoredForkSettings(): Promise<ForkAppSettingsStored> {
  const result = forkAppSettingsStoredSchema.safeParse((await readRawForkSettings()) ?? {});
  if (!result.success) {
    log(
      "fork settings read failed schema validation, using defaults. error:",
      formatZodError(result.error),
    );
    return forkAppSettingsStoredSchema.parse({});
  }
  return result.data;
}

async function writeForkSettings(
  settings: ForkAppSettingsStored,
  options: { useFileLock: boolean; guards?: ForkSettingsWriteGuards },
): Promise<void> {
  const forkSettingsFile = getForkSettingsFile();
  log("writing fork settings to:", forkSettingsFile, JSON.stringify(settings));
  await mkdir(getSettingsDir(), { recursive: true });
  if (options.guards && !options.guards.shouldCommit()) {
    // The queue turn expired while this write was pending: skip entirely, the same way
    // writeSettings() skips the main file, so a stale turn cannot overwrite a newer sidecar value.
    return;
  }
  await atomicWriteText(forkSettingsFile, JSON.stringify(settings, null, 2), {
    // Callers that hold the file lock themselves (read-merge-write) must not re-acquire it here.
    useFileLock: options.useFileLock,
    beforeRename: () => {
      if (options.guards && !options.guards.shouldCommit()) {
        throw new Error("stale fork settings write skipped before atomic rename");
      }
    },
  });
}

/**
 * Merge a fork patch into the sidecar. The whole read-merge-write runs under the sidecar's file
 * lock because separate setting-service instances (Desktop main, window Host, remote collections)
 * each have their own write queue but share the same file.
 */
export async function updateForkSettings(
  forkPatch: Partial<ForkAppSettingsStored>,
  guards?: ForkSettingsWriteGuards,
): Promise<void> {
  const forkSettingsFile = getForkSettingsFile();
  await withAtomicFileLock(forkSettingsFile, async () => {
    const merged = forkAppSettingsStoredSchema.parse({
      ...(await readStoredForkSettings()),
      ...forkAppSettingsPatchSchema.parse(forkPatch),
    });
    await writeForkSettings(merged, { useFileLock: false, guards });
  });
}

/**
 * One-time sidecar migration step: seed fork keys still living in setting.json (raw, pre-parse)
 * into the sidecar. The sidecar wins on conflicts — it is the source of truth once it exists.
 * No-op when there is nothing to migrate.
 */
export async function maybeSeedLegacyForkSettings(
  legacyForkSettings: Partial<ForkAppSettings> | undefined,
  guards?: ForkSettingsWriteGuards,
): Promise<void> {
  if (!legacyForkSettings) return;
  const forkSettingsFile = getForkSettingsFile();
  await withAtomicFileLock(forkSettingsFile, async () => {
    const merged = forkAppSettingsStoredSchema.parse({
      ...legacyForkSettings,
      ...(await readStoredForkSettings()),
    });
    await writeForkSettings(merged, { useFileLock: false, guards });
  });
}
