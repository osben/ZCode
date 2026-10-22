import { mkdir, readFile } from "node:fs/promises";
import type { ForkAppSettings, ForkAppSettingsStored } from "@zcode/shared";
import {
  forkAppSettingsPatchSchema,
  forkAppSettingsSchema,
  forkAppSettingsStoredSchema,
  formatZodError,
  pickForkSettings,
} from "@zcode/shared";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { resolveSettingsLocation, type SettingsLocation } from "./settingsPaths.js";

const forkLogger = createServiceLogger("forkSettings");
// info lines carry key names and counts only; settings values go to debug, which the service logger gates to development.
const log = (...args: unknown[]) => forkLogger.info(undefined, ...args);
const debugLog = (...args: unknown[]) => forkLogger.debug(undefined, ...args);

/** Same stale-write protection writeSettings() uses for the main file: an expired queue turn must not rename late. */
export interface ForkSettingsWriteGuards {
  shouldCommit: () => boolean;
}

/**
 * Strict JSON read for the migration re-read: read and parse failures propagate so the caller's
 * cleanup write cannot run after failed seeding (that would delete the legacy keys from their
 * only stored location). A missing file propagates too and is equally safe: nothing is seeded.
 */
async function readJsonFileStrict(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

/** Each function defaults to the current environment; service instances pass their pinned location. */
type LocationArg = SettingsLocation;

/**
 * Read the raw sidecar payload. Missing file and JSON-parse failures yield undefined (callers
 * degrade to defaults). With `throwOnIoError`, other I/O failures (EACCES/EBUSY/EPERM — transient
 * Windows antivirus/indexer locks) propagate instead: a read-merge-write must not treat a
 * temporarily unreadable file as empty, or the write back would delete the stored settings.
 */
async function readRawForkSettings(
  options: { throwOnIoError?: boolean; onIoError?: () => void } | undefined,
  location: LocationArg,
): Promise<unknown> {
  const forkSettingsFile = location.forkFile;
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
    if (options?.throwOnIoError) {
      throw err;
    }
    options?.onIoError?.();
    log("fork settings read failed, using defaults. error:", err);
    return undefined;
  }
}

/**
 * Effective sidecar view for consumers: stored values plus materialized defaults. Defaults exist
 * only in memory — they are never written back to the file, so a future default change reaches
 * everyone who never explicitly set the setting.
 */
export async function readForkSettings(
  location: LocationArg = resolveSettingsLocation(),
  options?: { onIoError?: () => void },
): Promise<ForkAppSettings> {
  const result = forkAppSettingsSchema.safeParse(
    (await readRawForkSettings({ onIoError: options?.onIoError }, location)) ?? {},
  );
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
export async function readStoredForkSettings(
  options?: { throwOnIoError?: boolean },
  location: LocationArg = resolveSettingsLocation(),
): Promise<ForkAppSettingsStored> {
  const result = forkAppSettingsStoredSchema.safeParse(
    (await readRawForkSettings(options, location)) ?? {},
  );
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
  location: LocationArg,
): Promise<void> {
  const forkSettingsFile = location.forkFile;
  debugLog("writing fork settings, keys:", Object.keys(settings).join(", "));
  debugLog("fork write payload:", JSON.stringify(settings));
  await mkdir(location.dir, { recursive: true });
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
  location: LocationArg = resolveSettingsLocation(),
): Promise<void> {
  await withAtomicFileLock(location.forkFile, async () => {
    const merged = forkAppSettingsStoredSchema.parse({
      // A non-ENOENT I/O error must abort the merge instead of rewriting the sidecar from an
      // empty base, which would delete every other stored fork setting.
      ...(await readStoredForkSettings({ throwOnIoError: true }, location)),
      ...forkAppSettingsPatchSchema.parse(forkPatch),
    });
    await writeForkSettings(merged, { useFileLock: false, guards }, location);
  });
}

/**
 * One-time sidecar migration step: seed fork keys still living in setting.json into the sidecar.
 * The sidecar wins on conflicts — it is the source of truth once it exists. No-op when there is
 * nothing to migrate.
 *
 * The legacy snapshot argument may be stale: it was captured outside the sidecar lock, and another
 * service instance may have migrated and even cleared sidecar keys in the meantime. Only keys
 * still present in setting.json are seeded, re-checked under the lock, so a stale snapshot can
 * never resurrect a value the user already cleared.
 */
export async function maybeSeedLegacyForkSettings(
  legacyForkSettings: Partial<ForkAppSettings> | undefined,
  guards?: ForkSettingsWriteGuards,
  location: LocationArg = resolveSettingsLocation(),
): Promise<void> {
  if (!legacyForkSettings) return;
  await withAtomicFileLock(location.forkFile, async () => {
    // Re-read the legacy source under the sidecar lock and let read/parse failures propagate:
    // if seeding cannot confirm the keys, the caller's cleanup write must not run and delete
    // them from their only stored location.
    const rawMain = await readJsonFileStrict(location.file);
    const stillPresent =
      rawMain && typeof rawMain === "object" && !Array.isArray(rawMain)
        ? pickForkSettings(rawMain as Record<string, unknown>)
        : {};
    if (Object.keys(stillPresent).length === 0) {
      return;
    }
    const merged = forkAppSettingsStoredSchema.parse({
      ...stillPresent,
      // Same data-integrity rule as updateForkSettings: a transiently unreadable sidecar must
      // abort the seeding instead of shrinking it to the legacy keys only.
      ...(await readStoredForkSettings({ throwOnIoError: true }, location)),
    });
    await writeForkSettings(merged, { useFileLock: false, guards }, location);
  });
}
