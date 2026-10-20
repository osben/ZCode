import { access, readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  extractLegacyForkSettings,
  forkAppSettingsPatchSchema,
  formatLogPrefix,
  formatZodError,
  splitForkSettingsPatch,
} from "@zcode/shared";
import type { ForkAppSettings } from "@zcode/shared";
import type { ISettingService, WorkspaceSettingsProjection } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import { copyDataDirectory, getDataBaseDir, validateDataBaseDirTarget } from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { createSettingsWriteQueue } from "./settingsWriteQueue.js";
import { resolveSettingsLocation, type SettingsLocation } from "./settingsPaths.js";
import {
  maybeSeedLegacyForkSettings,
  readForkSettings,
  updateForkSettings,
} from "./forkSettingsSidecar.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
  type LegacyTeamConnection,
} from "#src/setting/legacyAccountConnectionSettings.js";
const MAX_RECENT_PROJECTS = 10;
const DEFAULT_PROJECT_NAME = "ZCodeProject";
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
const debugLog = (...args: unknown[]) => {
  // NODE_ENV inherited from the user's shell can mislead the service-layer debug switch; use ZCODE_RUNTIME_ENV consistently.
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // A manual edit or remote disk failure may leave setting.json invalid (for example, containing ":wq").
    // Returning defaults without isolating the bad file would repeat the parse failure at every startup; preserve a backup so a later update can rebuild valid config.
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // Multiple services may read the same invalid setting.json during startup.
      // After the first read isolates it, later rename attempts encounter ENOENT; this is expected under concurrency and should not produce backup-failure error logs.
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    // In-memory migration would leave version 3 on disk for rollback clients; it must persist under the write lock.
    raw.remoteBoundaryOnboardingVersion === 3 ||
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true ||
    raw.taskAutoArchiveResetVersion !== 1
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
  /** Fork-owned keys found in the raw setting.json before the schema stripped them; set only when the one-time sidecar migration still has something to move. */
  legacyForkSettings?: Partial<ForkAppSettings>;
}
async function readSettingsWithMeta(location: SettingsLocation): Promise<ReadSettingsResult> {
  const settingsFile = location.file;
  try {
    // settingService.get() is called frequently by the UI and remote sessions.
    // Logging the full config on every read previously inflated production logs and exposed paths/config details; ordinary reads now log only at development debug level.
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // Another update may be overwriting setting.json, so a reader may briefly see partial JSON.
      // Retry briefly and isolate the file only after repeated failures, avoiding accidental reset of valid session config to defaults.
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    debugLog("read result:", JSON.stringify(result.data));
    return {
      settings: result.data,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
      legacyForkSettings: extractLegacyForkSettings(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // Fall back to defaults for file-parse and other errors.
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

async function readSettings(location: SettingsLocation): Promise<AppSettings> {
  return (await readSettingsWithMeta(location)).settings;
}

async function writeSettings(
  location: SettingsLocation,
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  runExclusiveCommit: (commit: () => Promise<void>) => Promise<void> = (commit) => commit(),
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
  baseWriteOptions?: { useFileLock?: boolean },
): Promise<void> {
  const settingsDir = location.dir;
  const settingsFile = location.file;
  // Tests on Windows may change only HOME; if a module-level constant freezes homedir() at import time,
  // later reads/writes still use the real user directory. Resolve the config path from the current environment each time for stable local/test behavior.
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  const persisted = { ...rollbackFields, ...settings };
  // When a legacy Team is waiting for OAuth to supply organization details, the schema default {} is not a new user choice.
  // Ordinary preference saves must preserve the new field's absence; only a migration commit or explicit connection selection ends the legacy import.
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    // Callers that hold the main-file lock across their whole read-merge-write turn (queued
    // updates and the migration) must not re-acquire it here.
    useFileLock: baseWriteOptions?.useFileLock !== false,
    beforeRename: () => {
      if (!shouldCommit()) {
        // An old write that times out before commit may clean up its temporary file, but must not rename late and overwrite a newer language preference.
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
    runRename: (renameFile) =>
      runExclusiveCommit(async () => {
        if (!shouldCommit()) throw new Error("stale settings write skipped before atomic rename");
        await renameFile();
      }),
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  return createSettingServiceWithMigrations().service;
}

/** Host-private migration entry point, not part of Setting RPC; ordinary get/update never wait for OAuth queries. */
export function createSettingServiceWithMigrations(): {
  service: ISettingService;
  setWorkspaceProjection: (
    reader: (settings: AppSettings) => Promise<WorkspaceSettingsProjection>,
  ) => void;
  prepareLegacyAccountConnections: (
    resolveOrganization: (connection: LegacyTeamConnection) => Promise<string | null>,
  ) => Promise<readonly ProviderFamilyDomain[]>;
} {
  const { enqueueSettingsWrite, runSettingsCommit, waitForQueuedWrites } =
    createSettingsWriteQueue();
  // Paths are pinned here: a later service created under another HOME must not redirect this instance's IO.
  const location = resolveSettingsLocation();
  // Upstream host assembly binds the workspace projection once. Fork keys are merged after projection,
  // so projection parsing (which strips unknown keys) never sees the sidecar values.
  let workspaceProjection:
    | ((settings: AppSettings) => Promise<WorkspaceSettingsProjection>)
    | undefined;
  const projectSettings = async (settings: AppSettings): Promise<AppSettings> =>
    workspaceProjection
      ? appSettingsSchema.parse({ ...settings, ...(await workspaceProjection(settings)) })
      : settings;

  const service: ISettingService = {
    async get(): Promise<AppSettings> {
      // A Session may be created or cold-restored immediately after settings change; if this read overtakes an enqueued write,
      // runtime will retain the old switch value. Wait for queued writes first so startup preferences use the committed choice.
      await waitForQueuedWrites();
      const result = await readSettingsWithMeta(location);
      const projected = await projectSettings(result.settings);
      const migrationPending =
        result.needsMigrationPersist || result.legacyForkSettings !== undefined;
      if (!migrationPending && JSON.stringify(projected) === JSON.stringify(result.settings)) {
        return { ...projected, ...(await readForkSettings(location)) };
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        // The whole main-file read-modify-write runs under the main-file lock: another service
        // instance saving a base preference while this turn's migration is in flight must not be
        // undone by this turn writing its older snapshot back.
        await mkdir(location.dir, { recursive: true });
        await withAtomicFileLock(location.file, async () => {
          const latest = await readSettingsWithMeta(location);
          await maybeSeedLegacyForkSettings(latest.legacyForkSettings, { shouldCommit }, location);
          const latestProjected = await projectSettings(latest.settings);
          const latestPending =
            latest.needsMigrationPersist || latest.legacyForkSettings !== undefined;
          if (
            !latestPending &&
            JSON.stringify(latestProjected) === JSON.stringify(latest.settings)
          ) {
            return;
          }

          // Initialization rationale: older settings may have persisted defaults with indistinguishable origins; migrate once using the schema after upgrade.
          // The schema no longer contains the fork keys, so the persisted object drops them here.
          await writeSettings(
            location,
            latestProjected,
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            false,
            { useFileLock: false },
          );
        });
      });

      const [settings, migratedForkSettings] = await Promise.all([
        readSettings(location),
        readForkSettings(location),
      ]);
      return { ...(await projectSettings(settings)), ...migratedForkSettings };
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        // Fork-owned keys are routed to the sidecar file before the main validation: their schemas
        // no longer exist in appSettingsPatchSchema, and an unknown key would be silently stripped.
        // Both halves of the patch are validated before either file is modified, so a mixed
        // valid/invalid patch rejects as a whole instead of half-applying.
        const { forkPatch, basePatch } = splitForkSettingsPatch(normalizeSettingsPatch(patch));
        const validatedPatch = appSettingsPatchSchema.parse(basePatch);
        const hasForkPatch = Object.keys(forkPatch).length > 0;
        const validatedForkPatch = hasForkPatch
          ? forkAppSettingsPatchSchema.parse(forkPatch)
          : undefined;
        // A full connection-mapping write from an unversioned caller would bypass the Composer's committed selection.
        if (
          Object.hasOwn(patch, "providerFamilyConnectionSelections") &&
          expectedAccountSettings?.providerFamilyDomainUpdatedAt === undefined
        ) {
          throw new Error("Account connection CAS required");
        }
        // The whole main-file read-modify-write runs under the main-file lock: a base preference
        // another service instance saves concurrently cannot be overwritten by this instance
        // writing back its older snapshot (the migration rewrite included).
        await mkdir(location.dir, { recursive: true });
        await withAtomicFileLock(location.file, async () => {
          const read = await readSettingsWithMeta(location);
          if (expectedAccountSettings) {
            // The user may switch accounts during the query. Validate inside the same write queue; a caller-side read-then-write is insufficient.
            const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
            if (
              read.settings.providerFamilyDomain !== expected.providerFamilyDomain ||
              // Same identity re-selected with an identical mapping still counts as a new operation when a version is supplied.
              (expected.providerFamilyDomainUpdatedAt !== undefined &&
                (read.settings.providerFamilyDomainUpdatedAt ?? 0) !==
                  expected.providerFamilyDomainUpdatedAt) ||
              JSON.stringify(read.settings.providerFamilyConnectionSelections ?? {}) !==
                JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
            ) {
              throw new Error("Account connection settings changed");
            }
          }
          // An update that arrives before the first get() must not destroy the only stored copy of
          // pre-sidecar fork preferences: seed the sidecar (sidecar wins) before the main file is
          // rewritten without those keys.
          await maybeSeedLegacyForkSettings(read.legacyForkSettings, { shouldCommit }, location);
          const merged = appSettingsSchema.parse({
            ...read.settings,
            ...validatedPatch,
          });

          // Opening a workspace writes recentProjects and lastWorkspaceSession almost simultaneously.
          // Previously both updates overwrote the file based on their own stale settings reads,
          // so the later patch could erase the earlier field and prevent session restoration at next startup.
          // Serialize writes so each patch merges against the latest state actually persisted by the previous write.
          if (merged.recentProjects) {
            merged.recentProjects = [...new Set(merged.recentProjects)].slice(
              0,
              MAX_RECENT_PROJECTS,
            );
          }
          // Each connection-mapping write is a new operation even when the selection is unchanged; the version
          // is monotonic because it is computed under the same main-file lock.
          if (Object.hasOwn(patch, "providerFamilyConnectionSelections")) {
            merged.providerFamilyDomainUpdatedAt = Math.max(
              validatedPatch.providerFamilyDomainUpdatedAt ?? Date.now(),
              (read.settings.providerFamilyDomainUpdatedAt ?? 0) + 1,
            );
          }

          await writeSettings(
            location,
            await projectSettings(merged),
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            Object.hasOwn(patch, "providerFamilyConnectionSelections"),
            { useFileLock: false },
          );
        });
        if (validatedForkPatch) {
          await updateForkSettings(validatedForkPatch, { shouldCommit }, location);
        }
      };

      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // The Windows install directory is managed by the installer/auto-updater; putting .zcode/v2 there may be overwritten during upgrades.
        // Block this in the service before migration so UI changes or RPC calls cannot bypass frontend checks.
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },

    async ensureDefaultProject(userHomeDir: string): Promise<{ path: string; created: boolean }> {
      const path = join(userHomeDir, DEFAULT_PROJECT_NAME);
      let existedBefore = true;

      try {
        await access(path).catch(() => {
          existedBefore = false;
        });
        maybeThrowInjectedFsFault({ operation: "mkdir", path });
        await mkdir(path, { recursive: true });
      } catch (error) {
        log("ensureDefaultProject failed:", error);
        throw error;
      }

      return { path, created: !existedBefore };
    },
  };

  let inFlight: Promise<readonly ProviderFamilyDomain[]> | null = null;
  let migrationComplete = false;
  return {
    service,
    setWorkspaceProjection(reader) {
      if (workspaceProjection) throw new Error("settings.workspace-projection-already-bound");
      workspaceProjection = reader;
    },
    prepareLegacyAccountConnections(resolveOrganization) {
      // After import completes, do not reread the migration file on every auth request. Restart Host to restore an older backup.
      if (migrationComplete) return Promise.resolve([]);
      if (inFlight) return inFlight;
      const run = async (): Promise<readonly ProviderFamilyDomain[]> => {
        await service.get();
        const original = await readLegacyAccountConnectionSettingsFile(location.file);
        const incomplete = readIncompleteLegacyTeamConnections(original);
        if (incomplete.length === 0) return [];
        // Network access is outside the write queue, so proxy-setting reads and user actions can continue without a get → HTTP → get cycle.
        const resolved = await Promise.all(
          incomplete.map(async (connection) => ({
            ...connection,
            organizationId: await resolveOrganization(connection).catch(() => null),
          })),
        );
        await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const latest = await readLegacyAccountConnectionSettingsFile(location.file);
          // Check only migration inputs; do not discard valid results on ordinary language/window changes or overwrite the user's new account choice.
          if (
            Object.hasOwn(latest, "providerFamilyConnectionSelections") ||
            latest.providerFamilyDomain !== original.providerFamilyDomain ||
            JSON.stringify(retainLegacyAccountConnectionFields(latest)) !==
              JSON.stringify(retainLegacyAccountConnectionFields(original))
          )
            return;
          if (resolved.some((entry) => !entry.organizationId?.trim())) return;
          const migrated = appSettingsSchema.parse(migrateLegacyAccountConnectionSettings(latest));
          const selections: ProviderFamilyConnectionSelectionSettings = {
            ...migrated.providerFamilyConnectionSelections,
          };
          for (const { family, productId, projectId, organizationId } of resolved) {
            selections[family] = {
              kind: "team-coding-plan",
              productId,
              projectId,
              organizationId: organizationId!.trim(),
            };
          }
          await writeSettings(
            location,
            { ...migrated, providerFamilyConnectionSelections: selections },
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            true,
          );
        });
        return readIncompleteLegacyTeamConnections(
          await readLegacyAccountConnectionSettingsFile(location.file),
        ).map((entry) => entry.family);
      };
      const pending = run();
      inFlight = pending;
      void pending.then(
        (unresolved) => {
          migrationComplete = unresolved.length === 0;
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
  };
}
