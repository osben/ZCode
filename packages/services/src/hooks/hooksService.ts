import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  Hook,
  HookEvent,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { parseWorkspaceHookTrustStoreContent } from "@zcode/shared/workspace-hook-trust-store-file";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IHooksService } from "./hooks.js";
import { atomicWriteWorkspaceHookConfig } from "./workspaceHookConfigMutation.js";
import {
  fromLegacyHooksConfig,
  fromProjectSnapshot,
  fromUserZCodeSource,
  resolveNextRootEnabled,
  toZCodeHooksEvents,
  type LegacyHooksConfig,
} from "./workspaceHookSettingsModel.js";

const SETTINGS_FILE = "settings.json";
const ZCODE_CONFIG_FILE = "config.json";
const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

interface ZCodeConfigFile {
  hooks?: WorkspaceHooksConfig;
  [key: string]: unknown;
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getRootDir(source: SettingsDirectorySource, workspacePath?: string): string {
  const baseDir = workspacePath ?? resolveUserHomeDir();
  if (source === "zcode") {
    return workspacePath ? join(baseDir, ".zcode") : join(baseDir, ".zcode", "cli");
  }
  return join(baseDir, source === "agents" ? ".agents" : ".claude");
}

function getConfigPath(source: SettingsDirectorySource, workspacePath?: string): string {
  return join(
    getRootDir(source, workspacePath),
    source === "zcode" ? ZCODE_CONFIG_FILE : SETTINGS_FILE,
  );
}

function buildLocation(
  source: SettingsDirectorySource,
  workspacePath?: string,
): SettingsDirectoryLocation {
  return {
    source,
    scope: workspacePath ? "project" : "user",
    directoryPath: getRootDir(source, workspacePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readUserZCodeSource(): Promise<WorkspaceHookSourceInput | undefined> {
  const path = getConfigPath("zcode");
  const config = await readJsonFile<Record<string, unknown>>(path);
  const parsed = workspaceHooksConfigSchema.safeParse(config?.hooks);
  if (!parsed.success) return undefined;
  return {
    ...createWorkspaceHookSourceInput({
      path,
      workingDirectory: resolveUserHomeDir(),
      hooks: parsed.data,
      discoveryOrder: 0,
      explicitProjectConfig: true,
    }),
    editable: true,
  };
}

async function loadLegacyHooksFromLocation(
  source: "agents" | "claude",
  workspacePath?: string,
): Promise<Hook[]> {
  return fromLegacyHooksConfig({
    legacyConfig: await readJsonFile<LegacyHooksConfig>(getConfigPath(source, workspacePath)),
    location: buildLocation(source, workspacePath),
    isHookEvent,
  });
}

/**
 * Read the persisted workspace hook trust digest set.
 *
 * Do not wrap the entire function in `try { ... } catch { return new Set(); }`:
 * that makes a corrupt/unreadable file indistinguishable from "no trust records" and provides no diagnostics. Root cause: if trust-store read errors are
 * swallowed, callers can only mark all hooks as `pending_trust` ("needs review"), while Runtime explicitly detects a corrupt trust store and blocks with `blocked_untrusted`—the user sees a review action,
 * but Runtime will never allow execution regardless of the review. This creates a display/runtime disagreement (both sides fail closed).
 *
 * Local hand-written field checks (isRecord + digest regex) disagreed with the complete strict schema used by runtime/adapters. Files with
 * "valid JSON but invalid structure" (missing schemaVersion, invalid decision/timestamp, unknown fields, etc.) could be treated as partially trusted here while runtime marked them
 * corrupt and blocked all hooks, so the UI showed "trusted" but hooks never ran. Trust storage is a permission boundary; every consumer must reach the same conclusion about the same file. Use shared's
 * parseWorkspaceHookTrustStoreContent (the single authoritative implementation from the contracts schema); any parse failure is corrupt + fail-closed, and no partial digests are returned.
 *
 * Note: storage directory resolution (~/ and relative paths in storage.dir) duplicates the equivalent logic in Runtime's
 * resolveWorkspaceHookTrustStorePath (adapters). Architecturally, services must not depend on adapters; consolidating this belongs in shared, and this comment records the duplication.
 */
async function readPersistentWorkspaceHookTrustDigests(
  workspaceIdentity: string,
  logger: ServiceLogger,
): Promise<{ digests: Set<string>; corrupt: boolean }> {
  const userConfig = (await readJsonFile<Record<string, unknown>>(getConfigPath("zcode"))) ?? {};
  const storage = isRecord(userConfig.storage) ? userConfig.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const home = resolveUserHomeDir();
  const storageRoot = configured
    ? configured.startsWith("~/")
      ? join(home, configured.slice(2))
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, configured)
    : join(home, ".zcode");
  const trustFilePath = join(storageRoot, "security", "workspace-hook-trust-v1.json");

  // Read asynchronously and distinguish ENOENT; do not preflight with existsSync, which blocks the service
  // thread and creates a TOCTOU window between check and read. ENOENT from readFile is the authoritative
  // signal that the file does not exist.
  let content: string;
  try {
    content = await readFile(trustFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      // Missing file ⇒ no records is valid; return an empty set without marking it corrupt.
      return { digests: new Set<string>(), corrupt: false };
    }
    // The services layer used to call console.warn directly, which did not reach the unified service log and could not accept an injected test sink.
    // Use the injectable ServiceLogger instead; this is a low-frequency recoverable fallback, so use warn.
    logger.warn(
      undefined,
      "Workspace Hook Trust store 不可读，已 fail-closed 忽略全部持久信任记录",
      {
        path: trustFilePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  // Treat JSON syntax errors and schema validation failures as corrupt, matching runtime/adapters.
  const parsedStore = parseWorkspaceHookTrustStoreContent(content);
  if (parsedStore.status === "invalid") {
    logger.warn(
      undefined,
      "Workspace Hook Trust store 结构不符合 schema，已 fail-closed 忽略全部持久信任记录",
      { path: trustFilePath },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  const digests = new Set<string>(
    parsedStore.file.records
      .filter((record) => record.workspaceIdentity === workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  return { digests, corrupt: false };
}

async function loadHooksImpl(
  params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope?: "all" | "user";
  },
  logger: ServiceLogger,
): Promise<{
  hooks: Hook[];
  hooksEnabled: boolean;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
}> {
  const workspacePath = resolve(params.workspacePath);
  if (params.scope === "user") {
    // Source Settings user scope reads only the user home, never the anchor path as a project.
    const userSource = await readUserZCodeSource();
    const runtimeRoot = resolveWorkspaceHookRuntimeRoot([userSource?.hooks]);
    const hooks = [
      ...fromUserZCodeSource({
        source: userSource,
        runtimeRoot,
        workspacePath,
        location: buildLocation("zcode"),
      }),
      ...(await loadLegacyHooksFromLocation("agents")),
      ...(await loadLegacyHooksFromLocation("claude")),
    ];
    return { hooks, hooksEnabled: hooks.some((hook) => hook.enabled) };
  }
  const workspaceIdentity = params.workspaceIdentity?.trim() || workspacePath;
  const [{ sources: projectSources }, userSource] = await Promise.all([
    readWorkspaceHookProjectSources({ workingDirectory: workspacePath }),
    readUserZCodeSource(),
  ]);
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    userSource?.hooks,
    ...projectSources.map((source) => source.hooks),
  ]);
  const workspaceHookSnapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath,
    sources: projectSources,
    runtimeRoot,
  });
  const persistentTrust = await readPersistentWorkspaceHookTrustDigests(workspaceIdentity, logger);
  const persistentTrustedDigests = persistentTrust.digests;
  const hooks = [
    ...fromProjectSnapshot({
      sources: projectSources,
      snapshot: workspaceHookSnapshot,
      workspaceIdentity,
      workspacePath,
      persistentTrustedDigests,
    }),
    ...(await loadLegacyHooksFromLocation("agents", workspacePath)),
    ...(await loadLegacyHooksFromLocation("claude", workspacePath)),
    ...fromUserZCodeSource({
      source: userSource,
      runtimeRoot,
      workspacePath,
      location: buildLocation("zcode"),
    }),
    ...(await loadLegacyHooksFromLocation("agents")),
    ...(await loadLegacyHooksFromLocation("claude")),
  ];
  return {
    hooks,
    hooksEnabled: hooks.some((hook) => hook.enabled),
    ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
    ...(persistentTrust.corrupt ? { trustStoreCorrupt: true } : {}),
  };
}

async function writeZCodeHooksConfig(
  workspacePath: string | undefined,
  hooks: Hook[],
): Promise<void> {
  const configPath = getConfigPath("zcode", workspacePath);
  const existingConfig = (await readJsonFile<ZCodeConfigFile>(configPath)) ?? {};
  const enabled = resolveNextRootEnabled(existingConfig.hooks?.enabled, hooks);
  await atomicWriteWorkspaceHookConfig(configPath, {
    ...existingConfig,
    hooks: {
      ...existingConfig.hooks,
      ...(enabled !== undefined ? { enabled } : {}),
      events: toZCodeHooksEvents(hooks),
    },
  });
}

async function saveHooksImpl(params: {
  workspaceIdentity?: string;
  workspacePath: string;
  scope?: "all" | "user";
  hooks: Hook[];
}): Promise<void> {
  const currentProjectConfigPath = resolve(params.workspacePath, ".zcode", "config.json");
  const userHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      (!hook.location || (hook.location.source === "zcode" && hook.location.scope === "user")),
  );
  const projectHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      hook.location?.source === "zcode" &&
      hook.location.scope === "project" &&
      (!hook.configuredState ||
        resolve(hook.configuredState.sourcePath) === currentProjectConfigPath),
  );
  await writeZCodeHooksConfig(undefined, userHooks);
  if (params.scope !== "user") {
    await writeZCodeHooksConfig(params.workspacePath, projectHooks);
  }
}

export function createHooksService(
  options: {
    logger?: ServiceLogger;
    grantWorkspaceHookTrust?: NonNullable<IHooksService["grantWorkspaceHookTrust"]>;
  } = {},
): IHooksService {
  const logger = options.logger ?? createServiceLogger("hooks-service");
  return {
    loadHooks: (params) => loadHooksImpl(params, logger),
    saveHooks: saveHooksImpl,
    ...(options.grantWorkspaceHookTrust
      ? { grantWorkspaceHookTrust: options.grantWorkspaceHookTrust }
      : {}),
  };
}
