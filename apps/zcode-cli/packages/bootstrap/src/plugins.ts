import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  addSuppressedBuiltinInFileConfig,
  createConfig,
  resolvePath,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
  type ConfigResult,
} from "@zcode/adapters/config";
import {
  addMarketplace,
  comparePluginUpdate,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  discoverNodePluginsSync,
  ensureMarketplaceManifestAvailable,
  getPluginSourceDiagnosticCode,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  parseMarketplaceSourceInput,
  parseEntryStoreListing,
  readPluginSourceIdentityPin,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginMarketplaceEntry,
} from "@zcode/adapters/plugins";
import type {
  Logger,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginStoreListing,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, isOfficialMarketplaceId } from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "./app/official-plugin-definitions.js";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";
import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";

export interface ResolveZCodePluginsOptions {
  configResult?: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

export interface ListZCodePluginsOptions extends ResolveZCodePluginsOptions {}

export interface SetZCodePluginEnabledOptions extends ResolveZCodePluginsOptions {
  enabled: boolean;
  plugin: string;
  scope?: "user" | "workspace";
}

export interface SetZCodePluginEnabledResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodeMarketplaceSummaryData {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial: boolean;
  refreshFailure?: {
    code: string;
    failedAt: string;
    message: string;
  };
  // Top-level curated featured list from the catalog (Featured section in the store's "Public" segment), shipped with the manifest.
  featured?: string[];
}

export interface ZCodeAvailablePluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  // Store metadata (display name/icon/category/author/links/hero/example prompts) from the catalog entry.
  listing?: PluginStoreListing;
}

export interface ZCodeInstalledPluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  // Store metadata for installed plugins is joined from catalog entries by ID (missing when a marketplace is removed; UI falls back).
  listing?: PluginStoreListing;
}

export interface ZCodePluginsOverviewData {
  marketplaces: ZCodeMarketplaceSummaryData[];
  availablePlugins: ZCodeAvailablePluginData[];
  installedPlugins: ZCodeInstalledPluginData[];
  restorableBuiltins: ZCodeAvailablePluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

export interface ZCodeMarketplaceUpdateData {
  diagnostics: PluginLoadOutcome["diagnostics"];
  marketplaces: ZCodeMarketplaceSummaryData[];
}

export interface AddZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  source: string;
  /** `marketplace add --sparse`: only git/github sources support sparse-checking out a subdirectory. */
  sparsePaths?: string[];
}

export interface RemoveZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
}

export interface UpdateZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  marketplace?: string;
}

export interface InstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  marketplace: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface UninstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  pluginId?: string;
  pluginName?: string;
  marketplace?: string;
  removeCache?: boolean;
  /** Preserve the user data directory at data/<plugin-id> (`zcode plugins uninstall --keep-data`). */
  keepData?: boolean;
}

export interface UpdateZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  pluginId: string;
}

export interface ValidateZCodePluginPathOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  path: string;
}

export interface ZCodePluginUpdateData extends ZCodePluginInstallData {
  previousVersion: string;
}

export interface RestoreBuiltinPluginOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
}

export interface ConfigureZCodePluginOptions extends ResolveZCodePluginsOptions {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ResetZCodePluginConfigOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ValidateZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface DescribeZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
  pluginName: string;
}

export interface ZCodePluginInstallData {
  dependencyClosure: string[];
  installedPlugins: ZCodeInstalledPluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

/**
 * Count only user-visible marketplace plugins.
 *
 * node-repl-host is the runtime host shared by Browser Use and Computer Use. It must remain in the
 * official manifest (otherwise it cannot be discovered, installed, or enabled), but it has no
 * skill or listing and should not appear in settings. Counting it would make the displayed plugin
 * count one greater than the number of listed entries.
 *
 * The check deliberately targets this named entry in the official marketplace, not "entries with
 * no listing." The latter would incorrectly affect third-party marketplaces, whose custom manifest
 * entries may legitimately omit listings and remain visible plugins.
 */
function countVisibleMarketplacePlugins(
  marketplaceId: string,
  plugins: readonly { name: string }[] | undefined,
): number | undefined {
  if (!plugins) return undefined;
  if (marketplaceId !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return plugins.length;
  return plugins.filter((entry) => entry.name !== OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME).length;
}

export function resolveZCodePlugins(options: ResolveZCodePluginsOptions = {}): PluginLoadOutcome {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);

  return discoverNodePluginsSync({
    config: configResult.config.plugins,
    env: options.env ?? process.env,
    officialPluginRoots: resolveOfficialPluginRoots({
      extraRoots: options.officialPluginRoots,
      // Cache lock conflicts are degraded rather than fatal now, so ordinary plugin entry points must retain diagnostic logs too.
      logger: options.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
    }),
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory,
  });
}

export function getZCodePluginsOverview(
  options: ResolveZCodePluginsOptions = {},
): ZCodePluginsOverviewData {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const effectiveMarketplaces = resolveEffectiveMarketplaceRecords({
    configResult,
    known,
    workingDirectory,
  });
  const marketplaceDeclarationDiagnostics = resolveMarketplaceDeclarationDiagnostics({
    configResult,
    known,
    workingDirectory,
  });
  const installed = listInstalledPluginRecords(pluginStorageRoot);
  const installedIds = new Set(installed.map((record) => record.id));

  // Read each marketplace manifest once to obtain both entries (catalog items) and featured (curated list).
  // The adapter merges built-in and CDN shards of zcode-plugins-official into one canonical manifest.
  const catalogs: Array<{
    summary: ZCodeMarketplaceSummaryData;
    entries: PluginMarketplaceEntry[];
  }> = [];
  for (const { record, useCachedManifest } of effectiveMarketplaces) {
    // Marketplace sources come only from User/Host configuration. Read Host cache only after the
    // target Host explicitly materializes the same source through refresh/install. The same ID with
    // a different source must fail closed to prevent another Host or stale config from using the
    // wrong global marketplace snapshot.
    const manifest = useCachedManifest
      ? loadMarketplaceManifestSync(pluginStorageRoot, record.id)
      : null;
    catalogs.push({
      summary: toMarketplaceSummaryData(
        record,
        manifest?.featured,
        countVisibleMarketplacePlugins(record.id, manifest?.plugins),
      ),
      entries: manifest?.plugins ?? [],
    });
  }

  // While traversing marketplace catalogs, record the latest version pin for each plugin ID for update detection.

  // An entry may have version, sha, or both, so collect both dimensions and let comparePluginUpdate
  // choose which to compare with the installed record.
  const latestPinByPluginId = new Map<string, { version?: string; sha?: string }>();
  // Also collect store metadata by ID for installed-plugin joins (shared by detail, icon-strip, and management views).
  const listingByPluginId = new Map<string, PluginStoreListing>();
  const availablePlugins = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => {
      const data = toAvailablePluginData(entry, catalog.summary.id, installedIds);
      latestPinByPluginId.set(data.id, {
        ...(entry.version ? { version: entry.version } : {}),
        ...(readPluginSourceIdentityPin(entry.source)
          ? { sha: readPluginSourceIdentityPin(entry.source) }
          : {}),
      });
      if (entry.listing) listingByPluginId.set(data.id, entry.listing);
      return data;
    }),
  );
  const loadedById = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));

  // Suppressed (uninstalled) built-in (official) plugins can be restored with one click: select
  // entries in OFFICIAL_PLUGIN_DEFINITIONS whose IDs are in suppressedBuiltins and map them to the
  // available shape for the UI's Restore action. The full catalog/cache remains; restorable is only
  // a projection of Runtime suppression state, and store metadata comes directly from the definition's listing seed.
  const suppressed = new Set(configResult.config.plugins.suppressedBuiltins);
  const restorableBuiltins: ZCodeAvailablePluginData[] = OFFICIAL_PLUGIN_DEFINITIONS.filter(
    (def) =>
      suppressed.has(`${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`) &&
      // Computer Use's restore action requires the internal feature to be enabled (same rule as restoreBuiltinPluginCore).
      (def.name !== "computer-use" || isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)),
  ).map((def) => {
    const listing = def.listing
      ? parseEntryStoreListing({ name: def.name, ...def.listing })
      : undefined;
    return {
      id: `${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      name: def.name,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      version: def.version,
      installed: false,
      ...(listing ? { listing } : {}),
    };
  });

  return {
    marketplaces: catalogs.map((catalog) => catalog.summary),
    availablePlugins,
    installedPlugins: installed.map((record) => {
      const enabled = configResult.config.plugins.enabledPlugins[record.id] ?? false;
      const data = toInstalledPluginData(record, enabled, loadedById.get(record.id));
      const pin = latestPinByPluginId.get(record.id);
      const installedSha = readPluginSourceIdentityPin(record.source);
      const updateStatus = comparePluginUpdate({
        installedVersion: data.version,
        installedSha,
        latestVersion: pin?.version,
        latestSha: pin?.sha,
      });
      // Display latestVersion using manifest version when available; otherwise use the latest short (7-character) SHA for a readable UI hint.
      const latestLabel = pin?.version ?? (pin?.sha ? pin.sha.slice(0, 7) : undefined);
      const listing = listingByPluginId.get(record.id);
      return {
        ...data,
        updateStatus,
        ...(latestLabel ? { latestVersion: latestLabel } : {}),
        ...(listing ? { listing } : {}),
      };
    }),
    restorableBuiltins,
    diagnostics: [
      ...outcome.diagnostics,
      ...marketplaceDeclarationDiagnostics,
      ...known.flatMap((record): PluginLoadOutcome["diagnostics"] =>
        record.lastRefreshFailure
          ? [
              {
                code: record.lastRefreshFailure.code,
                message: record.lastRefreshFailure.message,
                pluginId: record.id,
                severity: "error",
              },
            ]
          : [],
      ),
    ],
  };
}

export function enrichCachedClaudeMarketplaceIconsForOverview(
  options: ResolveZCodePluginsOptions = {},
): void {
  const { pluginStorageRoot } = resolvePluginContext(options);
  // Icons are an optional display enhancement: the overview does not wait for the network; only
  // the write-back phase takes the storage lock.
  void enrichCachedClaudeMarketplaceIcons(pluginStorageRoot, (write) =>
    withPluginStorageLock(pluginStorageRoot, write),
  );
}

export function listZCodePlugins(options: ListZCodePluginsOptions = {}): PluginLoadOutcome {
  const outcome = resolveZCodePlugins(options);
  const { pluginStorageRoot } = resolvePluginContext(options);
  return {
    ...outcome,
    // Resolve user-visible names from the marketplace listing. Pass the full ID to the CLI here;
    // do not mix display metadata into the adapter's runtime PluginMetadata or guess from a bare name.
    pluginListingsById: loadPluginListingsById(pluginStorageRoot),
  };
}

function loadPluginListingsById(storageRoot: string): Record<string, PluginStoreListing> {
  const listings = new Map<string, PluginStoreListing>();

  // Without a marketplace snapshot, the bundled official definition remains the safe fallback for built-in plugin listings.
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (!definition.listing) continue;
    const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
    if (listing) {
      listings.set(`${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`, listing);
    }
  }

  // Join catalog entries by the full `${name}@${marketplace}` key so same-named plugins do not overwrite each other.
  for (const marketplace of loadKnownMarketplacesSync(storageRoot)) {
    const manifest = loadMarketplaceManifestSync(storageRoot, marketplace.id);
    for (const entry of manifest?.plugins ?? []) {
      if (entry.listing) listings.set(`${entry.name}@${marketplace.id}`, entry.listing);
    }
  }

  return Object.fromEntries(listings);
}

export async function setZCodePluginEnabled(
  options: SetZCodePluginEnabledOptions,
): Promise<SetZCodePluginEnabledResult> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

export async function addZCodePluginMarketplace(
  options: AddZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

export async function removeZCodePluginMarketplace(
  options: RemoveZCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

export async function updateZCodePluginMarketplace(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // The map callback takes only its first argument: toMarketplaceSummaryData's second argument is featured, not map's index.
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

export async function installZCodeMarketplacePlugin(
  options: InstallZCodeMarketplacePluginOptions,
): Promise<ZCodePluginInstallData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.dryRun === true) {
    const declarationSource = resolveDeclaredMarketplaceSources({
      configResult,
    }).get(options.marketplace);
    const known = loadKnownMarketplacesSync(pluginStorageRoot).find(
      (record) => record.id === options.marketplace,
    );
    if (declarationSource && known && !isDeepStrictEqual(known.source, declarationSource)) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [createMarketplaceSourceRepointDiagnostic(options.marketplace)],
      };
    }
    if (
      declarationSource &&
      (!known || !loadMarketplaceManifestSync(pluginStorageRoot, options.marketplace))
    ) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: (
          await validateMarketplaceSource({
            expectedId: options.marketplace,
            pluginName: options.pluginName,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          })
        ).map(toPluginDiagnostic),
      };
    }
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: (
        await validateMarketplacePlugin({
          marketplace: options.marketplace,
          name: options.pluginName,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic),
    };
  }
  const pluginId = `${options.pluginName}@${options.marketplace}`;
  const bundledEntry = loadMarketplaceManifestSync(
    pluginStorageRoot,
    options.marketplace,
  )?.plugins.find((entry) => entry.name === options.pluginName);
  const isSuppressedBundledOfficial =
    options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
    configResult.config.plugins.suppressedBuiltins.includes(pluginId) &&
    (bundledEntry?.source === "filesystem" || bundledEntry?.source === "sea");
  if (isSuppressedBundledOfficial) {
    // A built-in plugin's filesystem/SEA entry is only a catalog pointer, not an ordinary
    // Marketplace source. Direct installation must reuse restore so the same official cache is not
    // written to installed_plugins.json; otherwise uninstall/update would mistake built-in assets
    // for user installs and break restore semantics.
    // The protocol layer already protects this call with a storage lock, so invoke the unlocked
    // core here; otherwise the promise-chain lock for the same storageRoot would wait on itself forever.
    await restoreBuiltinPluginCore({ ...options, configResult, pluginId });
    const fresh = resolvePluginContext({ ...options, configResult: undefined });
    const outcome = resolveZCodePlugins({
      ...options,
      configResult: fresh.configResult,
      pluginStorageRoot: fresh.pluginStorageRoot,
    });
    const restored = outcome.plugins.find((plugin) => plugin.id === pluginId);
    if (!restored) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          toPluginDiagnostic({
            code: "plugin_not_found",
            message: `Bundled plugin could not be restored: ${pluginId}`,
            pluginId,
            severity: "error",
          }),
        ],
      };
    }
    const now = new Date().toISOString();
    return {
      dependencyClosure: [pluginId],
      installedPlugins: [
        toInstalledPluginData(
          {
            id: restored.id,
            name: restored.name,
            marketplace: restored.marketplace,
            version: restored.version ?? "",
            installPath: restored.rootPath,
            installedAt: now,
            updatedAt: now,
            scope: "user",
          },
          restored.enabled,
          restored,
        ),
      ],
      diagnostics: [],
    };
  }
  let installed: Awaited<ReturnType<typeof installMarketplacePlugin>>;
  try {
    await materializeDeclaredMarketplaceForExplicitAction({
      configResult,
      marketplaceId: options.marketplace,
      pluginStorageRoot,
      abortSignal: options.abortSignal,
      workingDirectory,
    });
    installed = await installMarketplacePlugin({
      signal: options.abortSignal,
      marketplace: options.marketplace,
      name: options.pluginName,
      // The package/cache/installed record belongs to the target Host's User inventory.
      // Legacy protocol Workspace scope remains for compatibility only and must not change the
      // Marketplace behavior of writing default-enabled state to User config. Installed records
      // have no workspace identity and cannot participate in Workspace config ownership.
      scope: "user",
      storageRoot: pluginStorageRoot,
    });
  } catch (error) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: [
        toMarketplaceInstallDiagnostic(error, `${options.pluginName}@${options.marketplace}`),
      ],
    };
  }
  if (options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    // The official marketplace shares the built-in plugin ID space. When reinstalling a same-named
    // CDN plugin, clear historical built-in suppression or Runtime will still treat the owned install as suppressed.
    for (const record of installed.installed) {
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, record.id);
    }
  }
  // Marketplace manages only Host User inventory. Even if a legacy protocol caller passes Workspace
  // scope, installation's default-enabled state must go to User config rather than becoming a
  // Workspace override. Apply only to IDs not explicitly declared in user config (do not overwrite
  // explicit choices such as reinstalling after disabling).
  const { enabledIds } = await enablePluginsByDefaultInFileConfig(
    configResult.sources.user.path,
    installed.installed.map((record) => record.id),
  );
  const enabledIdSet = new Set(enabledIds);
  // Preserve the current enabled state for explicit config; mark newly default-enabled entries true.
  const enabledById = (id: string): boolean =>
    enabledIdSet.has(id) || (configResult.config.plugins.enabledPlugins[id] ?? false);
  return {
    dependencyClosure: installed.closure,
    installedPlugins: installed.installed.map((record) =>
      toInstalledPluginData(record, enabledById(record.id)),
    ),
    diagnostics: [],
  };
}

export async function uninstallZCodeMarketplacePlugin(
  options: UninstallZCodeMarketplacePluginOptions,
): Promise<ZCodeInstalledPluginData | null> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const pluginId = resolvePluginIdForMutation(options);

    // The official CDN marketplace and built-in plugins share the zcode-plugins-official ID space,
    // and its cache also lives under the official cache. If runtime source="official" is checked
    // first, a CDN plugin with an installed_plugins.json record is mistaken for a built-in plugin;
    // only suppression is written and the install record remains, leaving the UI permanently
    // installed and preventing reinstall. The persisted install record is authoritative for
    // Marketplace ownership and must take precedence over runtime source classification. Also clear
    // any stale incorrect suppression so state can self-heal.
    const installedRecord = listInstalledPluginRecords(pluginStorageRoot).find(
      (record) => record.id === pluginId,
    );
    if (installedRecord) {
      const removed = await uninstallMarketplacePlugin({
        pluginId,
        // Uninstall means full removal: delete cache and data directories too unless the caller explicitly sets removeCache=false.
        removeCache: options.removeCache ?? true,
        keepData: options.keepData,
        storageRoot: pluginStorageRoot,
      });
      if (!removed) return null;
      await removePluginFromFileConfig(configResult.sources.user.path, removed.id);
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, removed.id);
      return toInstalledPluginData(removed, false);
    }

    // Built-in (official) plugins are not in installed_plugins.json and cannot use the Marketplace
    // uninstall path. Uninstall changes only Runtime suppression state and clears user data/config;
    // keep the catalog and immutable cache so detail pages can still read components offline and
    // restore does not require a download or directory reconstruction.
    const outcome = resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot,
      workingDirectory,
    });
    const builtin = outcome.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.source === "official",
    );
    if (builtin) {
      await addSuppressedBuiltinInFileConfig(configResult.sources.user.path, pluginId);
      // Clear enabledPlugins[id] and options[id] from user config before deleting directories:
      // the suppression marker is already the sole source of truth (written atomically via
      // temp+rename), so even if later deletion throws, the next resolve skips and completes cache
      // removal. Clearing config first guarantees "restore starts clean" even if deletion fails midway.
      await removePluginFromFileConfig(configResult.sources.user.path, pluginId);
      // Keep the official cache: like the Marketplace Catalog, it is read-only data needed for detail and restore.
      if (options.keepData !== true) {
        await rm(getPluginDataDir(pluginStorageRoot, pluginId), { force: true, recursive: true });
      }
      const now = new Date().toISOString();
      return toInstalledPluginData(
        {
          id: builtin.id,
          name: builtin.name,
          marketplace: builtin.marketplace,
          version: builtin.version ?? "",
          installPath: builtin.rootPath,
          installedAt: now,
          updatedAt: now,
          scope: "user",
        },
        false,
      );
    }

    return null;
  });
}

/**
 * `zcode plugins update <plugin>`: refresh the owning marketplace catalog, then reinstall from the same entry.
 * cacheMarketplacePlugin overwrites an existing install record in place and preserves installedAt;
 * enabled state receives a default only for IDs not explicitly declared in user config, so updates
 * do not change the user's existing toggle choices.
 */
export async function updateZCodeMarketplacePlugin(
  options: UpdateZCodeMarketplacePluginOptions,
): Promise<ZCodePluginUpdateData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const record = listInstalledPluginRecords(pluginStorageRoot).find(
    (installed) => installed.id === options.pluginId,
  );
  if (!record) throw new Error(`Plugin not installed: ${options.pluginId}`);
  const refreshed = await updateZCodePluginMarketplace({
    ...options,
    marketplace: record.marketplace,
  });
  const refreshErrors = refreshed.diagnostics.filter((item) => item.severity === "error");
  if (refreshErrors.length > 0) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: refreshErrors,
      previousVersion: record.version,
    };
  }
  const installed = await installZCodeMarketplacePlugin({
    ...options,
    marketplace: record.marketplace,
    pluginName: record.name,
    scope: record.scope,
  });
  return { ...installed, previousVersion: record.version };
}

/** `zcode plugins validate <path>`: read-only validation of a local plugin or marketplace directory. */
export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

/**
 * Unlocked core for restoring a suppressed (uninstalled) built-in (official) plugin.
 *
 * The caller may already hold the storage lock for this storageRoot (for example, a protocol
 * install handler), so this core must not acquire the promise-chain lock again. The public entry
 * point provides locking.
 */
async function restoreBuiltinPluginCore(options: RestoreBuiltinPluginOptions): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // Although overview hides the restore action, protocol calls can still bypass the UI and write
    // user config. If the feature flag is off, fail before writing so user config and plugin cache remain untouched.
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // Reread the latest config from disk (after the patch) to ensure the suppression set no longer
  // contains the restored ID; do not reuse the configResult that may have been passed before patching.
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // Reseed immediately so the plugin is available without waiting for the next resolve.
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}

export async function configureZCodePlugin(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

/** Remove Plugin config keys for the given scope so Workspace scope falls back to User. */
export async function resetZCodePluginConfig(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // "Restore inheritance" removes only the Workspace enable override. Options are an independent
    // config dimension; restoring inherited enable state must not also erase Workspace options/secrets.
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}

export async function validateZCodePlugin(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
  });
}

function resolvePluginContext(options: ResolveZCodePluginsOptions): {
  configResult: ConfigResult;
  pluginStorageRoot: string;
  workingDirectory: string;
} {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const storageRoot = resolvePath(configResult.config.storage.dir);
  return {
    configResult,
    pluginStorageRoot:
      options.pluginStorageRoot ?? getPluginStorageRoot(getCliStorageRoot(storageRoot)),
    workingDirectory,
  };
}

function resolveDeclaredMarketplaceSources(input: {
  configResult: ConfigResult;
}): Map<string, MarketplaceSource> {
  return new Map(
    Object.entries(input.configResult.config.plugins.extraKnownMarketplaces ?? {}).map(
      ([marketplaceId, declaration]) => {
        const baseDirectory = dirname(input.configResult.sources.plugins.paths.user);
        return [marketplaceId, resolveDeclaredMarketplaceSource(declaration.source, baseDirectory)];
      },
    ),
  );
}

function resolveDeclaredMarketplaceSource(
  source: ConfigResult["config"]["plugins"]["extraKnownMarketplaces"][string]["source"],
  baseDirectory: string,
): MarketplaceSource {
  // Resolve User Marketplace relative paths from the User config directory. Reading config does
  // not touch the source; only explicit refresh/install reads, copies, or accesses the network.
  if (source.source === "file" || source.source === "directory") {
    return {
      ...source,
      path: isAbsolute(source.path) ? resolve(source.path) : resolve(baseDirectory, source.path),
    };
  }
  return source;
}

function resolveEffectiveMarketplaceRecords(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): Array<{ record: KnownMarketplaceRecord; useCachedManifest: boolean }> {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownIds = new Set(input.known.map((record) => record.id));
  const records = input.known.map((record) => {
    const declarationSource = declared.get(record.id);
    if (!declarationSource) return { record, useCachedManifest: true };
    if (isDeepStrictEqual(record.source, declarationSource)) {
      return { record, useCachedManifest: true };
    }
    // The official marketplace ID is reserved by the Host. A Workspace declaration with the same
    // ID but a different source may produce diagnostics only; it must not replace the official
    // cache projection with an empty catalog showing pluginCount=0.
    if (isOfficialMarketplaceId(record.id)) {
      return { record, useCachedManifest: true };
    }
    return {
      record: createDeclaredMarketplaceRecord(record.id, declarationSource),
      useCachedManifest: false,
    };
  });
  for (const [marketplaceId, source] of declared) {
    if (knownIds.has(marketplaceId)) continue;
    if (isOfficialMarketplaceId(marketplaceId)) continue;
    records.push({
      record: createDeclaredMarketplaceRecord(marketplaceId, source),
      useCachedManifest: false,
    });
  }
  return records;
}

function resolveMarketplaceDeclarationDiagnostics(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): PluginLoadOutcome["diagnostics"] {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownById = new Map(input.known.map((record) => [record.id, record]));
  return [...declared.entries()].flatMap(([marketplaceId, source]) => {
    if (!isOfficialMarketplaceId(marketplaceId)) return [];
    const known = knownById.get(marketplaceId);
    if (known && isDeepStrictEqual(known.source, source)) return [];
    return [createReservedMarketplaceDeclarationDiagnostic(marketplaceId)];
  });
}

function createDeclaredMarketplaceRecord(
  marketplaceId: string,
  source: MarketplaceSource,
): KnownMarketplaceRecord {
  return {
    id: marketplaceId,
    source,
    name: marketplaceId,
    addedAt: "",
    pluginCount: 0,
  };
}

async function materializeDeclaredMarketplaceForExplicitAction(input: {
  abortSignal?: AbortSignal;
  configResult: ConfigResult;
  marketplaceId: string;
  pluginStorageRoot: string;
  workingDirectory: string;
}): Promise<void> {
  const source = resolveDeclaredMarketplaceSources(input).get(input.marketplaceId);
  if (!source) return;
  const known = loadKnownMarketplacesSync(input.pluginStorageRoot).find(
    (record) => record.id === input.marketplaceId,
  );
  if (known && !isDeepStrictEqual(known.source, source)) {
    throw new MarketplaceSourceRepointError(
      createMarketplaceSourceRepointDiagnostic(input.marketplaceId).message,
    );
  }
  if (known && loadMarketplaceManifestSync(input.pluginStorageRoot, input.marketplaceId)) {
    return;
  }
  await addMarketplace({
    expectedId: input.marketplaceId,
    signal: input.abortSignal,
    source,
    storageRoot: input.pluginStorageRoot,
  });
}

function resolvePluginSelector(selector: string, plugins: PluginMetadata[]): PluginMetadata {
  const normalized = selector.trim();
  const exact = plugins.find((plugin) => plugin.id === normalized);
  if (exact) return exact;

  const nameMatches = plugins.filter((plugin) => plugin.name === normalized);
  if (nameMatches.length === 1 && nameMatches[0]) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(`Plugin name is ambiguous, use full plugin id: ${normalized}`);
  }
  throw new Error(`Plugin not found: ${normalized}`);
}

function toMarketplaceSummaryData(
  record: KnownMarketplaceRecord,
  featured?: string[],
  pluginCount?: number,
): ZCodeMarketplaceSummaryData {
  return {
    id: record.id,
    name: record.name,
    source: record.source as unknown as Record<string, unknown>,
    ...(record.description ? { description: record.description } : {}),
    ...(record.lastUpdated ? { lastUpdated: record.lastUpdated } : {}),
    pluginCount: pluginCount ?? record.pluginCount,
    isOfficial: isOfficialMarketplaceId(record.id),
    ...(record.lastRefreshFailure
      ? {
          refreshFailure: {
            code: record.lastRefreshFailure.code,
            failedAt: record.lastRefreshFailure.failedAt,
            message: record.lastRefreshFailure.message,
          },
        }
      : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
  };
}

function toAvailablePluginData(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  installedIds: ReadonlySet<string>,
): ZCodeAvailablePluginData {
  const id = `${entry.name}@${marketplace}`;
  return {
    id,
    name: entry.name,
    marketplace,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    installed: installedIds.has(id),
    componentTypes: inferComponentTypes(entry.raw),
    ...(entry.listing ? { listing: entry.listing } : {}),
  };
}

function toInstalledPluginData(
  record: InstalledPluginRecord,
  enabled: boolean,
  loaded?: PluginMetadata,
): ZCodeInstalledPluginData {
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    ...((loaded?.description ?? undefined) ? { description: loaded?.description } : {}),
    version: loaded?.version ?? record.version,
    enabled,
    scope: record.scope,
    installPath: record.installPath,
    installedAt: record.installedAt,
    componentTypes: loaded ? inferComponentTypesFromMetadata(loaded) : undefined,
    ...(loaded ? { hookDetails: loaded.hookDetails } : {}),
  };
}

function inferComponentTypes(raw: Record<string, unknown>): string[] {
  const types: string[] = [];
  if ("agents" in raw) types.push("agent");
  if ("commands" in raw) types.push("command");
  if ("skills" in raw) types.push("skill");
  if ("hooks" in raw) types.push("hook");
  if ("mcpServers" in raw) types.push("mcp");
  if ("lspServers" in raw) types.push("lsp");
  return types;
}

function inferComponentTypesFromMetadata(plugin: PluginMetadata): string[] {
  const types: string[] = [];
  // Agents are enumerated from a conventional directory and may not appear in the manifest; checking only the manifest would omit installed subagent capabilities.
  if (plugin.components.some((group) => group.kind === "agent" && group.items.length > 0)) {
    types.push("agent");
  }
  if (plugin.commandRootCount > 0) types.push("command");
  if (plugin.skillRootCount > 0 || plugin.skillCount > 0) types.push("skill");
  if (plugin.declaredMcpServerNames.length > 0 || plugin.mcpServerNames.length > 0) {
    types.push("mcp");
  }
  if (plugin.lspServerNames.length > 0) types.push("lsp");
  if (plugin.hookDetails.length > 0) types.push("hook");
  return types;
}

function resolvePluginIdForMutation(options: UninstallZCodeMarketplacePluginOptions): string {
  if (options.pluginId) return options.pluginId;
  if (options.pluginName && options.marketplace) {
    return `${options.pluginName}@${options.marketplace}`;
  }
  throw new Error("pluginId or pluginName + marketplace is required");
}

function normalizePluginOptions(
  options: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function normalizePluginOptionKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0))];
}

function resolvePluginConfigPath(
  options: ResolveZCodePluginsOptions & { scope?: "user" | "workspace" },
  configResult: ConfigResult,
  workingDirectory: string,
): string {
  if (options.scope !== "workspace") {
    return configResult.sources.user.path;
  }

  // Workspace Plugin config always lives at the current `<workspace>/.zcode/config.json`. Nested
  // workspaces may discover both the repository-root config and their own; reads prefer the
  // innermost, and writes must target the current workspace rather than the first outermost file
  // found by project discovery.
  const workspaceConfigPath = join(workingDirectory, ".zcode", "config.json");
  const projectConfigPaths = [
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
    ...configResult.sources.project.paths,
  ];
  const existingWorkspaceConfig = projectConfigPaths.find(
    (path) =>
      normalizePluginConfigPathForComparison(path) ===
      normalizePluginConfigPathForComparison(workspaceConfigPath),
  );
  if (existingWorkspaceConfig) return existingWorkspaceConfig;
  return workspaceConfigPath;
}

function normalizePluginConfigPathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedPath = platform === "win32" ? win32.resolve(path) : resolve(path);
  return platform === "win32" ? resolvedPath.replaceAll("\\", "/").toLowerCase() : resolvedPath;
}

export function isWorkspacePluginConfigPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return (
      win32.basename(path).toLowerCase() === "config.json" &&
      win32.basename(win32.dirname(path)).toLowerCase() === ".zcode"
    );
  }
  return basename(path) === "config.json" && basename(dirname(path)) === ".zcode";
}

export function resolveMarketplaceRefreshTargetIds(input: {
  declaredIds: Iterable<string>;
  knownIds: Iterable<string>;
  marketplace?: string;
}): string[] {
  if (input.marketplace) return [input.marketplace];
  // refresh-all updates only already-materialized Host known records. Project declarations must
  // be materialized explicitly one by one, preventing a bulk refresh from writing arbitrary
  // Workspace declarations into global Marketplace state.
  return [...new Set(input.knownIds)];
}

function createMarketplaceSourceRepointDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_invalid",
    message:
      `Workspace marketplace declaration "${marketplaceId}" conflicts with an existing Host source. ` +
      "Remove the existing marketplace or use a different marketplace id before materializing it.",
    pluginId: marketplaceId,
    severity: "error",
  };
}

function createReservedMarketplaceDeclarationDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_declaration_reserved",
    message:
      `Workspace marketplace declaration "${marketplaceId}" uses a reserved official id and was ignored. ` +
      "Use a different marketplace id for project declarations.",
    pluginId: marketplaceId,
    severity: "warning",
  };
}

class MarketplaceSourceRepointError extends Error {}

function toPluginDiagnostic(diagnostic: {
  code: string;
  message: string;
  pluginId?: string;
  severity: "warning" | "error";
}): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: diagnostic.code as PluginLoadOutcome["diagnostics"][number]["code"],
    message: diagnostic.message,
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
    severity: diagnostic.severity,
  };
}

function toMarketplaceInstallDiagnostic(
  error: unknown,
  pluginId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MarketplaceSourceRepointError) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_invalid",
      message,
      pluginId,
      severity: "error",
    });
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return toPluginDiagnostic({
      code: sourceCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.startsWith("Plugin not found:")) {
    return toPluginDiagnostic({
      code: "plugin_not_found",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("Cross-marketplace dependency")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cross_marketplace",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("dependency cycle")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cycle",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return toPluginDiagnostic({
      code: "plugin_dependency_missing",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("source is recognized but not supported")) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_source_unsupported",
      message,
      pluginId,
      severity: "error",
    });
  }
  return toPluginDiagnostic({
    code: "plugin_marketplace_invalid",
    message,
    pluginId,
    severity: "error",
  });
}

function toMarketplaceRefreshDiagnostic(
  error: unknown,
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  return toPluginDiagnostic({
    code: getPluginSourceDiagnosticCode(error) ?? "plugin_marketplace_invalid",
    message,
    pluginId: marketplaceId,
    severity: "error",
  });
}
