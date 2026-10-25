/* oxlint-disable eslint(max-lines) -- The AppSettings schema centralizes legacy migrations, defaults, and patch validation; splitting it would weaken the single entry point for settings migration. */
import { z } from "zod";
import { appToolSearchModeSchema } from "./app-runtime-preferences.js";
import type { AppSettings } from "./protocol.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { ZCODE_ENABLED_AGENT_PROVIDERS } from "./zcode-agent-policy.js";
import { DYNAMIC_WORKFLOW_MODES } from "./dynamic-workflow-feature.js";
import { normalizeZCodeEndpointOrigin } from "./zcodeEndpoint.js";
import {
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  embeddedBrowserViewportPreferenceSchema,
} from "./browser-use/command-metadata.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";
import {
  connectionProfileSchema,
  sourceServerRecordSchema,
  sourceServerWorkspaceHistoryEntrySchema,
} from "./source-server/contracts.js";

/** Onboarding occupation enum; exported separately for narrow validation when onboarding records backfill settings. */
const appSettingsOccupationSchema = z.enum([
  "office",
  "developer",
  "independent",
  "infrastructure",
  "product",
  "design",
  "student",
  "creator",
  "operations",
  "marketing",
  "finance",
  "accounting",
  "legal",
  "other",
]);
export const appSettingsOccupationEnum = appSettingsOccupationSchema;

const nonEmptyStringSchema = z.string().trim().min(1);

export const localeSchema = z.enum(["zh-CN", "en-US", "uk-UA"]);
// The persisted shared keys hold only what the upstream app can read; uk-UA lives in the fork
// sidecar (specs/fork-locale-storage.md). Full localeSchema stays for release notes and migration.
export const sharedLocaleSchema = z.enum(["zh-CN", "en-US"]);
export const sharedLocalePreferenceSchema = z.enum(["system", "zh-CN", "en-US"]);
const zcodeInteractionBehaviorSchema = z.enum(["queue", "guide"]);
// launch.md "The user's choice": when reading files, an unknown value (written by a newer version and read after a downgrade) is treated as "follow,"
// so one preference field cannot corrupt the entire settings read.
const dynamicWorkflowModeSettingSchema = z.enum(DYNAMIC_WORKFLOW_MODES).optional().catch(undefined);
const electronReleaseChannelSchema = z.enum(["stable", "preview"]);
const desktopZoomLevelSchema = z.number().int().min(-3).max(5);
const desktopWindowSizeSchema = z.object({
  width: z.number().int().min(480),
  height: z.number().int().min(640),
  maximized: z.boolean(),
});
export const integratedTerminalShellSelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("auto"),
  }),
  z.object({
    mode: z.literal("shell"),
    dialect: z.enum(["cmd", "git-bash"]),
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  }),
]);
const enabledBuiltinAgentCliProvidersSchema = z
  // Legacy-settings compatibility: historical lists may retain third-party CLI providers; normalize to ZCode Agent after parsing.
  .array(z.enum(["claude", "opencode", "gemini", "codex", "glm"]))
  .transform(() => [...ZCODE_ENABLED_AGENT_PROVIDERS]);
const providerFamilyDomainSchema = z.enum(["zai", "bigmodel"]);
export const postUpdateReleaseNotesPayloadSchema = z.object({
  version: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  markdown: nonEmptyStringSchema,
  releaseDate: nonEmptyStringSchema.optional(),
  releaseNotesByLocale: z
    .partialRecord(
      localeSchema,
      z.object({ title: nonEmptyStringSchema, markdown: nonEmptyStringSchema }),
    )
    .optional(),
});

const skippedElectronUpdateVersionsSchema = z
  .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
  .default({});

const remoteWorkspaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ssh"),
    host: nonEmptyStringSchema,
    port: z.number().int().positive().max(65535).optional(),
    username: nonEmptyStringSchema,
    sshConfigAlias: nonEmptyStringSchema.optional(),
    privateKeyPath: z.string().optional(),
    assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
    resourcePackages: z
      .object({
        selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
      })
      .optional(),
    passwordCredentialKey: nonEmptyStringSchema.optional(),
    privateKeyPassphraseCredentialKey: nonEmptyStringSchema.optional(),
  }),
  z.object({
    kind: z.literal("wsl"),
    distro: z.string().optional(),
    // Reconnecting remote history uses the WSL user from settings directly; share validation with the connection entry point to prevent bypassing the UI and corrupting identity/logs.
    user: wslUserSchema.optional(),
  }),
  z.object({
    kind: z.literal("docker"),
    container: nonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal("server"),
    url: z.string().url(),
    name: nonEmptyStringSchema.optional(),
    workspacePath: z.string().optional(),
    serverId: nonEmptyStringSchema.optional(),
    tokenCredentialKey: nonEmptyStringSchema.optional(),
  }),
]);

const appWorkspaceSessionEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    workspacePath: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).default("project"),
  }),
  z.object({
    kind: z.literal("remote"),
    workspacePath: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).default("project"),
    localWorkspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    target: remoteWorkspaceTargetSchema,
    lastOpenedAt: z.number().int().nonnegative(),
    lastConnectionStatus: z.enum(["connected", "failed"]),
    lastConnectionError: z.string().optional(),
  }),
]);

const webRemoteControlRelayV2DeviceSchema = z.object({
  deviceSid: z.string().min(1),
  userId: z.string().min(1),
  endpointOrigin: z.url(),
});
const remoteConversationWorkspaceRecordSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    lastResolvedAt: z.number().int().nonnegative(),
  })
  .strict();

const webRemoteControlExternalRelayDeviceSchema = z.object({
  deviceSid: nonEmptyStringSchema,
});
const webRemoteControlLastEnabledContextSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  initialTaskId: nonEmptyStringSchema.optional(),
});
const zcodeEndpointOriginSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return normalizeZCodeEndpointOrigin(trimmed);
  } catch {
    return undefined;
  }
}, z.string().optional());

function sanitizeZCodeEndpointOrigin(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("zcodeEndpointOrigin" in raw)) {
    return value;
  }
  const parsed = zcodeEndpointOriginSchema.safeParse(raw.zcodeEndpointOrigin);
  if (parsed.success && typeof parsed.data === "string") {
    return { ...raw, zcodeEndpointOrigin: parsed.data };
  }
  const { zcodeEndpointOrigin: _zcodeEndpointOrigin, ...next } = raw;
  // Non-production endpoint overrides are developer-support fields; discard an invalid value without breaking the entire settings read.
  return next;
}

function sanitizeDesktopWindowSize(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("desktopWindowSize" in raw)) {
    return value;
  }
  const parsed = desktopWindowSizeSchema.safeParse(raw.desktopWindowSize);
  if (parsed.success) {
    return value;
  }
  const { desktopWindowSize: _desktopWindowSize, ...next } = raw;
  // Window dimensions are non-critical preferences; validating a bad value as part of the full schema would reset every other valid setting to its default.
  // When reading historical settings, discard only corrupted fields; keep strict validation for write patches to avoid producing more bad data.
  return next;
}

function sanitizeEmbeddedBrowserViewportPreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (!("embeddedBrowserViewportPreference" in raw)) {
    return value;
  }
  const parsed = embeddedBrowserViewportPreferenceSchema.safeParse(
    raw.embeddedBrowserViewportPreference,
  );
  if (parsed.success) {
    return value;
  }
  const { embeddedBrowserViewportPreference: _embeddedBrowserViewportPreference, ...next } = raw;
  // Display preferences are not critical startup state; one corrupted field should not quarantine the entire setting.json.
  // On read, discard invalid preferences and use defaults; patch writes still strictly reject invalid dimensions and zoom values.
  return next;
}

function migrateRemoteBoundaryIntroAcknowledgement(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.remoteBoundaryOnboardingVersion !== 3) return value;
  // 原因：旧客户端只接受 2，写 3 会让整份设置回退默认值。迁移已确认的 3 到新字段，
  // 同时恢复旧字段合同；不能仅收窄 schema，否则修复版读取存量 3 也会丢设置。
  return {
    ...raw,
    remoteBoundaryOnboardingVersion: 2,
    remoteBoundaryIntroAcknowledgedVersion: 1,
  };
}

function migrateTaskAutoArchiveReset(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.taskAutoArchiveResetVersion === 1) return value;
  // 旧版开关开启后可能未执行；修复后直接沿用会在启动时突然归档历史会话。
  // 首次读取统一关闭并持久化标记，用户重新开启后不再重置。
  return { ...raw, taskAutoArchiveEnabled: false, taskAutoArchiveResetVersion: 1 };
}

function migrateCloseToTrayOnWindowsDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.closeToTrayOnWindowsMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // Initialization rationale: legacy versions saved both the default false and a user-selected off state as the same value, making them impossible to distinguish reliably.
    // Enable it once for this version; after writing the migration marker, preserve true/false according to the user's explicit choice.
    closeToTrayOnWindows: true,
    closeToTrayOnWindowsMigrationInitialized: true,
  };
}

function migrateMessageStreamShowReasoningDefault(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const raw = value as Record<string, unknown>;
  if (raw.messageStreamShowReasoningMigrationInitialized === true) {
    return value;
  }
  return {
    ...raw,
    // Initialization rationale: legacy versions saved both the default false and a user-selected off state as the same value, making them impossible to distinguish reliably.
    // Enable it once for this version; after writing the migration marker, preserve true/false according to the user's explicit choice.
    messageStreamShowReasoning: true,
    messageStreamShowReasoningMigrationInitialized: true,
  };
}

function migrateLegacyLocalePreference(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as Record<string, unknown>;
  if ("localePreference" in raw || !("locale" in raw)) {
    return value;
  }

  const parsedLocale = localeSchema.safeParse(raw.locale);
  if (!parsedLocale.success) {
    return value;
  }

  return {
    ...raw,
    // Legacy setting.json contains only locale, so it cannot distinguish "the user explicitly selected zh-CN" from "zh-CN is the default."
    // Preserve the locale in existing legacy config as an explicit preference, avoiding an unintended switch to system after upgrade.
    localePreference: parsedLocale.data,
  };
}

const legacyRemoteWorkspaceHistoryEntrySchema = z.object({
  id: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  localWorkspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  target: remoteWorkspaceTargetSchema,
  lastOpenedAt: z.number().int().nonnegative(),
  lastConnectionStatus: z.enum(["connected", "failed"]),
  lastConnectionError: z.string().optional(),
});

function migrateLegacyBuiltinAgentCliProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as {
    enabledBuiltinAgentCliProviders?: unknown;
  };

  // Bugfix: after the single-ZCode-Agent migration, legacy setting.json may still store enabled state for
  // removed third-party CLI providers. If those values kept reaching UI / bot provider options, they would clash with the single glm state on the server side.
  // Normalize to ZCode Agent at the schema entry point so core provider state has a single source of truth.
  return {
    ...raw,
    enabledBuiltinAgentCliProviders: [...ZCODE_ENABLED_AGENT_PROVIDERS],
  };
}

function stripHistoricalRemoteResourcePackages(target: unknown): unknown {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return target;
  }

  const rawTarget = target as Record<string, unknown>;
  if (rawTarget.kind !== "ssh" || !("resourcePackages" in rawTarget)) {
    return target;
  }

  const { resourcePackages: _resourcePackages, ...nextTarget } = rawTarget;
  // SSH deployment always uses the full active resource set; resourcePackages in legacy setting.json is historical filtering,
  // so clear it at the config entry point to prevent later reconnects or tab restores from reading it.
  return nextTarget;
}

function migrateLegacyWorkspaceSession(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const raw = value as {
    lastOpenTabs?: unknown;
    lastWorkspaceSession?: unknown;
    remoteWorkspaceHistory?: unknown;
  };
  const migrated = { ...raw } as Record<string, unknown>;
  const lastWorkspaceSession = Array.isArray(raw.lastWorkspaceSession)
    ? raw.lastWorkspaceSession
    : [];

  const hasLegacyRemoteEntries = lastWorkspaceSession.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return "historyId" in (entry as Record<string, unknown>);
  });

  const legacyRemoteHistory = Array.isArray(raw.remoteWorkspaceHistory)
    ? raw.remoteWorkspaceHistory
    : [];
  const legacyRemoteHistoryById = new Map(
    legacyRemoteHistory.flatMap((entry) => {
      const sanitizedEntry =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? {
              ...(entry as Record<string, unknown>),
              // Older remoteWorkspaceHistory entries may contain retired resource-package IDs.
              // Strip legacy selections before schema validation to avoid accidentally deleting the entire remote history during migration.
              target: stripHistoricalRemoteResourcePackages(
                (entry as Record<string, unknown>).target,
              ),
            }
          : entry;
      const parsed = legacyRemoteWorkspaceHistoryEntrySchema.safeParse(sanitizedEntry);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );

  const migratedWorkspaceSessionEntries: Record<string, unknown>[] =
    lastWorkspaceSession.length > 0
      ? lastWorkspaceSession.flatMap((entry): Record<string, unknown>[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }

          const rawEntry = entry as Record<string, unknown>;
          if (rawEntry.kind === "local" && typeof rawEntry.workspacePath === "string") {
            return [
              {
                kind: "local",
                workspacePath: rawEntry.workspacePath,
                workspacePurpose:
                  rawEntry.workspacePurpose === "conversation" ? "conversation" : "project",
              },
            ];
          }

          if (rawEntry.kind === "remote") {
            if (typeof rawEntry.workspacePath === "string" && rawEntry.target) {
              return [
                {
                  ...rawEntry,
                  target: stripHistoricalRemoteResourcePackages(rawEntry.target),
                },
              ];
            }

            if (typeof rawEntry.historyId === "string") {
              const legacyRemoteEntry = legacyRemoteHistoryById.get(rawEntry.historyId);
              return legacyRemoteEntry
                ? [
                    {
                      kind: "remote",
                      workspacePath: legacyRemoteEntry.workspacePath,
                      ...(legacyRemoteEntry.localWorkspacePath
                        ? { localWorkspacePath: legacyRemoteEntry.localWorkspacePath }
                        : {}),
                      ...(legacyRemoteEntry.workspaceIdentity
                        ? { workspaceIdentity: legacyRemoteEntry.workspaceIdentity }
                        : {}),
                      target: stripHistoricalRemoteResourcePackages(legacyRemoteEntry.target),
                      lastOpenedAt: legacyRemoteEntry.lastOpenedAt,
                      lastConnectionStatus: legacyRemoteEntry.lastConnectionStatus,
                      ...(legacyRemoteEntry.lastConnectionError
                        ? { lastConnectionError: legacyRemoteEntry.lastConnectionError }
                        : {}),
                    },
                  ]
                : [];
            }
          }

          return [];
        })
      : [];
  const migratedLegacyLocalEntries = Array.isArray(raw.lastOpenTabs)
    ? raw.lastOpenTabs.flatMap((workspacePath) =>
        typeof workspacePath === "string"
          ? [
              {
                kind: "local" as const,
                workspacePath,
                workspacePurpose: "project" as const,
              },
            ]
          : [],
      )
    : [];
  const existingLocalWorkspacePaths = new Set(
    migratedWorkspaceSessionEntries.flatMap((entry) =>
      entry.kind === "local" && typeof entry.workspacePath === "string"
        ? [entry.workspacePath]
        : [],
    ),
  );
  const nextWorkspaceSession = [
    ...migratedWorkspaceSessionEntries,
    ...migratedLegacyLocalEntries.filter(
      (entry) => !existingLocalWorkspacePaths.has(entry.workspacePath),
    ),
  ];

  // Legacy setting.json stores local sessions, remote history, and combined sessions in three separate places,
  // so deleting only one of them would leave startup recovery in a split state: "the list is present but cannot be restored" or "remote data remains."
  // Merge them into lastWorkspaceSession during schema parsing and explicitly remove the legacy fields,
  // ensuring all subsequent reads and writes use a single source of truth.
  if (
    nextWorkspaceSession.length > 0 ||
    hasLegacyRemoteEntries ||
    Array.isArray(raw.lastOpenTabs)
  ) {
    migrated.lastWorkspaceSession = nextWorkspaceSession;
  }
  delete migrated.lastOpenTabs;
  delete migrated.remoteWorkspaceHistory;
  return migrated;
}

const appSettingsObjectSchema = z.object({
  recentProjects: z.array(z.string()).default([]),
  // An unknown locale (such as a new language written by a newer version and then read by an older version) falls back only to the default:
  // A strict enum failure would invalidate all of setting.json; settingService would fall back to defaultSettings() and erase all settings on the next write.
  locale: sharedLocaleSchema.default("zh-CN").catch("zh-CN"),
  // User shortcut overrides (semantic validation is tolerant in the effective map in ui/src/shortcuts; the schema validates shape only).
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: sharedLocalePreferenceSchema.default("system").catch("system"),
  terminalInheritSystemProfile: z.boolean().default(true),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().default(false),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.default(
    DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  ),
  // Computer-control entry points in the input box are hidden by default; retain the setting and default it to off.
  // default applies only when the field is absent; users who explicitly saved false continue to have it hidden.
  computerUseComposerEntryHidden: z.boolean().default(true),
  taskAutoArchiveEnabled: z.boolean().default(false),
  taskAutoArchiveResetVersion: z.literal(1).default(1),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).default(30),
  closeToTrayOnWindows: z.boolean().default(true),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().default(true),
  // default(false): fresh installs and existing users alike are treated as not yet migrated on first launch; the main process decides per platform whether to migrate.
  closeToTrayLinuxMigrationInitialized: z.boolean().default(false),
  keepAwakeWhileRunning: z.boolean().default(false),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().default(true),
  messageStreamShowReasoning: z.boolean().default(true),
  messageStreamShowReasoningMigrationInitialized: z.boolean().default(true),
  messageStreamShowTodos: z.boolean().default(false),
  toolGroupingExploreEnabled: z.boolean().default(true),
  toolGroupingTerminalEnabled: z.boolean().default(true),
  toolGroupingChangesEnabled: z.boolean().default(false),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.default("queue"),
  askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
  modelIoFullRetentionEnabled: z.boolean().default(false),
  dynamicWorkflowMode: dynamicWorkflowModeSettingSchema,
  enabledBuiltinAgentCliProviders: enabledBuiltinAgentCliProvidersSchema.default([
    ...ZCODE_ENABLED_AGENT_PROVIDERS,
  ]),
  startPlanRecommendationDismissed: z.boolean().default(false),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.default({}),
  providerFamilyDomain: providerFamilyDomainSchema.optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().default(false),
  nativeSearchEnhancementsEnabled: z.boolean().default(true),
  toolSearchMode: appToolSearchModeSchema.default("off"),
  onboardingOccupation: appSettingsOccupationSchema.nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().default(false),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).default([]),
  lastActiveWorkspace: appWorkspaceSessionEntrySchema.nullable().optional(),
  remoteConversationWorkspaceBySourceServerId: z
    .record(nonEmptyStringSchema, remoteConversationWorkspaceRecordSchema)
    .optional(),
  sourceServers: z.array(sourceServerRecordSchema).default([]),
  connectionProfiles: z.array(connectionProfileSchema).default([]),
  sourceServerWorkspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema).default([]),
  // Bug 原因：该开关过去只声明在 patch schema，SettingService 合并后再走完整 schema 时会把
  // 显式 false 剥离，导致重启后恢复为默认开启。完整 schema 必须拥有这项持久化事实。
  remoteStartupAutoReconnectEnabled: z.boolean().optional(),
  sourceServerDirectoryMigrationVersion: z.literal(1).optional(),
  remoteBoundaryOnboardingVersion: z.literal(2).optional(),
  remoteBoundaryIntroAcknowledgedVersion: z.literal(1).optional(),
  lastActiveTabIndex: z.number().int().nonnegative().default(0),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  // releaseNotesByLocale uses localeSchema as its key, and an unknown language would invalidate all settings; discarding update notes is far less costly than losing every setting.
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional().catch(undefined),
  receivePreviewUpdates: z.boolean().default(false),
  autoDownloadAndInstallUpdates: z.boolean().default(false),
  skippedElectronUpdateVersions: skippedElectronUpdateVersionsSchema,
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  webRemoteControlRelayV2Device: webRemoteControlRelayV2DeviceSchema.optional(),
  webRemoteControlExternalRelayDevice: webRemoteControlExternalRelayDeviceSchema.optional(),
  webRemoteControlLastEnabledContext: webRemoteControlLastEnabledContextSchema.optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});

export const appSettingsSchema = z.preprocess(
  (value) =>
    sanitizeEmbeddedBrowserViewportPreference(
      sanitizeDesktopWindowSize(
        migrateMessageStreamShowReasoningDefault(
          migrateCloseToTrayOnWindowsDefault(
            migrateLegacyLocalePreference(
              sanitizeZCodeEndpointOrigin(
                migrateLegacyWorkspaceSession(
                  migrateLegacyBuiltinAgentCliProviders(
                    migrateRemoteBoundaryIntroAcknowledgement(migrateTaskAutoArchiveReset(value)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  appSettingsObjectSchema,
);

export const appSettingsPatchSchema = z.object({
  recentProjects: z.array(z.string()).optional(),
  locale: sharedLocaleSchema.optional(),
  shortcutBindings: z.record(z.string(), z.array(z.string())).optional(),
  localePreference: sharedLocalePreferenceSchema.optional(),
  terminalInheritSystemProfile: z.boolean().optional(),
  terminalFontFamily: nonEmptyStringSchema.optional(),
  integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
  httpProxy: nonEmptyStringSchema.optional(),
  httpProxyNoProxy: nonEmptyStringSchema.optional(),
  httpProxyCaCertPath: nonEmptyStringSchema.optional(),
  embeddedBrowserAllowInsecureCertificates: z.boolean().optional(),
  embeddedBrowserViewportPreference: embeddedBrowserViewportPreferenceSchema.optional(),
  computerUseComposerEntryHidden: z.boolean().optional(),
  taskAutoArchiveEnabled: z.boolean().optional(),
  taskAutoArchiveOlderThanDays: z.number().int().positive().max(365).optional(),
  closeToTrayOnWindows: z.boolean().optional(),
  keepAwakeWhileRunning: z.boolean().optional(),
  closeToTrayOnWindowsMigrationInitialized: z.boolean().optional(),
  closeToTrayLinuxMigrationInitialized: z.boolean().optional(),
  desktopZoomLevel: desktopZoomLevelSchema.optional(),
  desktopWindowSize: desktopWindowSizeSchema.optional(),
  desktopChromiumHardwareAccelerationEnabled: z.boolean().optional(),
  messageStreamShowReasoning: z.boolean().optional(),
  messageStreamShowReasoningMigrationInitialized: z.boolean().optional(),
  messageStreamShowTodos: z.boolean().optional(),
  toolGroupingExploreEnabled: z.boolean().optional(),
  toolGroupingTerminalEnabled: z.boolean().optional(),
  toolGroupingChangesEnabled: z.boolean().optional(),
  zcodeInteractionBehavior: zcodeInteractionBehaviorSchema.optional(),
  askUserQuestionAutoResolutionEnabled: z.boolean().optional(),
  modelIoFullRetentionEnabled: z.boolean().optional(),
  // The empty string is the "clear the selection and return to follow" sentinel: RPC swallows undefined, and normalizeSettingsPatch normalizes it to a deletion.
  dynamicWorkflowMode: z.union([z.enum(DYNAMIC_WORKFLOW_MODES), z.literal("")]).optional(),
  enabledBuiltinAgentCliProviders: enabledBuiltinAgentCliProvidersSchema.optional(),
  startPlanRecommendationDismissed: z.boolean().optional(),
  providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema.optional(),
  providerFamilyDomain: z.union([providerFamilyDomainSchema, z.literal("")]).optional(),
  providerFamilyDomainUpdatedAt: z.number().int().nonnegative().optional(),
  providerFamilyDomainMigrated: z.boolean().optional(),
  nativeSearchEnhancementsEnabled: z.boolean().optional(),
  toolSearchMode: appToolSearchModeSchema.optional(),
  onboardingOccupation: z
    .enum([
      "office",
      "developer",
      "independent",
      "infrastructure",
      "product",
      "design",
      "student",
      "creator",
      "operations",
      "marketing",
      "finance",
      "accounting",
      "legal",
      "other",
    ])
    .nullish(),
  proactiveSuggestionsEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  lastWorkspaceSession: z.array(appWorkspaceSessionEntrySchema).optional(),
  lastActiveWorkspace: appWorkspaceSessionEntrySchema.nullable().optional(),
  remoteConversationWorkspaceBySourceServerId: z
    .record(nonEmptyStringSchema, remoteConversationWorkspaceRecordSchema)
    .optional(),
  sourceServers: z.array(sourceServerRecordSchema).optional(),
  connectionProfiles: z.array(connectionProfileSchema).optional(),
  sourceServerWorkspaceHistory: z.array(sourceServerWorkspaceHistoryEntrySchema).optional(),
  remoteStartupAutoReconnectEnabled: z.boolean().optional(),
  sourceServerDirectoryMigrationVersion: z.literal(1).optional(),
  remoteBoundaryOnboardingVersion: z.literal(2).optional(),
  remoteBoundaryIntroAcknowledgedVersion: z.literal(1).optional(),
  lastActiveTabIndex: z.number().int().nonnegative().optional(),
  lastActiveTaskByWorkspace: z.record(z.string(), z.string()).optional(),
  dataBaseDir: z.string().trim().min(1).optional(),
  pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional(),
  receivePreviewUpdates: z.boolean().optional(),
  autoDownloadAndInstallUpdates: z.boolean().optional(),
  skippedElectronUpdateVersions: z
    .partialRecord(electronReleaseChannelSchema, nonEmptyStringSchema)
    .optional(),
  settingsSyncFirstRunPromptHandled: z.boolean().optional(),
  webRemoteControlRelayV2Device: webRemoteControlRelayV2DeviceSchema.optional(),
  webRemoteControlExternalRelayDevice: webRemoteControlExternalRelayDeviceSchema.optional(),
  webRemoteControlLastEnabledContext: webRemoteControlLastEnabledContextSchema.optional(),
  zcodeEndpointOrigin: zcodeEndpointOriginSchema.optional(),
});
