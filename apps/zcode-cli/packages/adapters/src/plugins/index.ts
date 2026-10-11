import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CustomCommandRoot,
  HookConfig,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginConfig,
  PluginDiagnostic,
  PluginDiscoverRequest,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginManifest,
  PluginUiSurfaceDefinition,
  PluginMetadata,
  PluginOperationOptions,
  PluginPort,
  SkillRoot,
} from "@zcode/contracts";
import {
  HookEventName as HookEventNameValue,
  HookMatcherConfigSchema,
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@zcode/contracts";
import {
  directoryExists,
  fileExists,
  isMissingPath,
  isNotFoundError,
  isRecord,
  parsePathList,
  resolveInside,
  sanitizePluginId,
  throwIfAborted,
} from "./helpers.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import { parsePluginUiSurfaces } from "./ui-surfaces.js";
import { listPluginHookSources } from "./hook-sources.js";
import { enumeratePluginComponents } from "./plugin-components.js";
import {
  listInstalledPluginRecords,
  normalizeAuthorValue,
  resolveInstalledPluginRoot,
} from "./marketplace.js";
import { loadBundledOfficialPluginRootsSync } from "./official-marketplace.js";
import type {
  LoadedPlugin,
  PluginAbortOptions,
  PluginCandidate,
  PluginComponents,
} from "./types.js";

export {
  addMarketplace,
  applyClaudePluginIcons,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryStoreListing,
  parsePluginIconSources,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateLocalPluginPath,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginComponentGroup,
  type PluginComponentItem,
  type PluginComponentKind,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from "./marketplace.js";

export {
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
} from "./official-marketplace.js";

export { getPluginSourceDiagnosticCode } from "./source-errors.js";

export {
  comparePluginUpdate,
  comparePluginVersions,
  type PluginUpdateStatus,
} from "./version-compare.js";

const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const FIRST_PLUGIN_PRIORITY = 1_000;
const PRIORITY_STEP = 10;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UNSUPPORTED_COMPONENT_KEYS = ["channels", "lspServers", "outputStyles", "settings"] as const;
const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

interface PluginHookInspection {
  details: PluginHookDetail[];
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export interface NodePluginAdapterOptions {
  storageRoot: string;
}

export class NodePluginAdapter implements PluginPort {
  constructor(private readonly options: NodePluginAdapterOptions) {}

  async discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome> {
    return this.discoverPluginsSync(request, options);
  }

  discoverPluginsSync(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): PluginLoadOutcome {
    if (!request.config.enabled) return emptyOutcome();

    const diagnostics: PluginDiagnostic[] = [];
    const dataRoot = join(request.storageRoot || this.options.storageRoot, "data");
    const candidates = this.resolveCandidates(request, diagnostics, options);
    const commandRoots: CustomCommandRoot[] = [];
    const hooks: PluginLoadOutcome["hooks"] = {};
    const mcpServers: PluginLoadOutcome["mcpServers"] = {};
    const plugins: PluginMetadata[] = [];
    const seen = new Set<string>();
    const skillRoots: SkillRoot[] = [];
    let priority = FIRST_PLUGIN_PRIORITY;

    for (const candidate of candidates) {
      throwIfAborted(options);
      const loaded = loadPlugin(candidate, diagnostics);
      if (!loaded) continue;
      // Uninstalling a built-in (official) plugin writes only a suppressedBuiltins marker to user config. Filter it at
      // discovery time using the plugin's authoritative id (manifest name @ marketplace), without relying on the cache
      // directory having been physically deleted. This also prevents rediscovery if an app upgrade leaves an old cache
      // directory or a session facade holds stale config. Apply this only to the official source; inline/cache (marketplace installs) are unaffected.
      if (loaded.source === "official" && request.config.suppressedBuiltins.includes(loaded.id)) {
        continue;
      }
      if (seen.has(loaded.id)) {
        diagnostics.push({
          code: "plugin_duplicate_id",
          message: `Duplicate plugin ignored: ${loaded.id}`,
          path: loaded.rootPath,
          pluginId: loaded.id,
          severity: "warning",
        });
        continue;
      }
      seen.add(loaded.id);
      warnUnsupportedComponents(loaded, diagnostics);

      // candidate.defaultEnabled cannot access the plugin id while constructing the candidate,
      // so also apply the bootstrap-provided default-enabled list here (matched by
      // `<name>@<marketplace>`).
      const candidateDefaultEnabled =
        candidate.defaultEnabled ||
        (request.officialPluginsEnabledByDefault?.has(loaded.id) ?? false);
      const enabled = resolveEnabled(request.config, loaded.id, candidateDefaultEnabled);
      const dataPath = join(dataRoot, sanitizePluginId(loaded.id));
      // Building mcpServerNames only from components resolved after enabling would hide built-in MCP
      // servers from the management page for disabled plugins. Read the declared names for read-only UI
      // display; runtime injection still uses only component.mcpServers resolved by the enabled branch.
      const mcpServerDefinitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
      const hooksRunnable = canRunPluginHooks(loaded);
      const hookInspection = inspectPluginHooks({
        dataPath,
        diagnostics,
        loaded,
        runnable: hooksRunnable,
      });
      const component = enabled
        ? resolveEnabledComponents({
            dataPath,
            diagnostics,
            env: request.env ?? {},
            hookEvents: hooksRunnable ? hookInspection.events : {},
            hookDetails: hookInspection.details,
            loaded,
            mcpServerDefinitions,
            options: request.config.options[loaded.id] ?? {},
            priority,
            workingDirectory: request.workingDirectory,
          })
        : emptyComponents(hookInspection.details);
      priority += PRIORITY_STEP;

      Object.assign(mcpServers, component.mcpServers);
      mergeHookEvents(hooks, component.hooks);
      skillRoots.push(...component.skillRoots);
      commandRoots.push(...component.commandRoots);
      const declaredMcpServerNames = Object.keys(mcpServerDefinitions);
      plugins.push(
        createPluginMetadata(
          loaded,
          component,
          dataPath,
          enabled,
          declaredMcpServerNames,
          request.config.options[loaded.id] ?? {},
          // Plugin UI panel entry (A5): resolve regardless of enabled state; listUiSurfaces filters entries for disabled plugins.
          parsePluginUiSurfaces({ loaded, declaredMcpServerNames, diagnostics }),
        ),
      );
    }

    return {
      commandRoots,
      diagnostics,
      hooks,
      mcpServers,
      plugins,
      skillRoots,
    };
  }

  private resolveCandidates(
    request: Pick<PluginDiscoverRequest, "config" | "officialPluginRoots" | "storageRoot">,
    diagnostics: PluginDiagnostic[],
    options?: PluginAbortOptions,
  ): PluginCandidate[] {
    const candidates: PluginCandidate[] = [];
    for (const rootPath of request.config.dirs) {
      candidates.push({
        defaultEnabled: true,
        marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "inline",
      });
    }
    for (const rootPath of request.officialPluginRoots ?? []) {
      candidates.push({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "official",
      });
    }
    candidates.push(
      ...scanOfficialCache(request.storageRoot, diagnostics, options).map((rootPath) => ({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath,
        source: "official" as const,
      })),
    );
    for (const installed of listInstalledPluginRecords(request.storageRoot)) {
      candidates.push({
        defaultEnabled: false,
        marketplace: installed.marketplace,
        rootPath: resolveInstalledPluginRoot(request.storageRoot, installed),
        source: "cache",
      });
    }
    return candidates;
  }
}

export function createNodePluginAdapter(options: NodePluginAdapterOptions): NodePluginAdapter {
  return new NodePluginAdapter(options);
}

export function discoverNodePluginsSync(
  request: PluginDiscoverRequest,
  options?: PluginAbortOptions,
): PluginLoadOutcome {
  return createNodePluginAdapter({ storageRoot: request.storageRoot }).discoverPluginsSync(
    request,
    options,
  );
}

function createPluginMetadata(
  loaded: LoadedPlugin,
  component: PluginComponents,
  dataPath: string,
  enabled: boolean,
  declaredMcpServerNames: string[],
  configuredOptions: Record<string, string | number | boolean>,
  uiSurfaces: PluginUiSurfaceDefinition[],
): PluginMetadata {
  // Use the manifest's author and homepage as fallbacks for the details page (the store listing has
  // priority).
  const author = normalizeAuthorValue(loaded.manifest.author);
  const homepage =
    typeof loaded.manifest.homepage === "string" && loaded.manifest.homepage.trim().length > 0
      ? loaded.manifest.homepage
      : undefined;
  return {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    commandRootCount: component.commandRoots.length,
    // The details UI previously combined plugin.skillCount (the authoritative count) with a UI-side
    // join that filtered skillsService results by pluginName. These data sources diverged: disabled
    // plugins used emptyComponents(), making skillCount zero, and the UI join omitted their names
    // (`if (!enabled) continue` in skillsService). As a result, the skills group disappeared when a
    // plugin was disabled, and enabled plugins showed a count without names. Enumerate the plugin root
    // authoritatively regardless of enabled state and include names and descriptions in the list, so
    // the UI no longer needs this fragile join.
    components: enumeratePluginComponents(loaded.rootPath, loaded.manifest, { loaded }),
    configuredOptions,
    dataPath,
    declaredMcpServerNames,
    description: loaded.manifest.description,
    enabled,
    id: loaded.id,
    manifestPath: loaded.manifestPath,
    marketplace: loaded.marketplace,
    mcpServerNames: Object.keys(component.mcpServers),
    name: loaded.manifest.name,
    hookDetails: component.hookDetails,
    rootPath: loaded.rootPath,
    skillCount: component.skillCount,
    skillRootCount: component.skillRoots.length,
    source: loaded.source,
    ...(uiSurfaces.length > 0 ? { uiSurfaces } : {}),
    userConfig: loaded.manifest.userConfig,
    version: loaded.manifest.version,
  };
}

function resolveEnabledComponents(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  hookDetails: PluginHookDetail[];
  hookEvents: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  loaded: LoadedPlugin;
  mcpServerDefinitions: Record<string, unknown>;
  options: Record<string, string | number | boolean>;
  priority: number;
  workingDirectory: string;
}): PluginComponents {
  mkdirSync(input.dataPath, { recursive: true });

  const skillRoots = resolveSkillRoots(input, input.priority);
  return {
    commandRoots: resolveCommandRoots(input, input.priority + 1),
    hooks: input.hookEvents,
    hookDetails: input.hookDetails,
    mcpServers: resolvePluginMcpServers({
      ...input,
      definitions: input.mcpServerDefinitions,
    }),
    // The plugin page must show the actual skill count. Counting skills roots incorrectly showed a
    // plugin such as document-skills as 1 even when one root contained multiple SKILL.md files.
    skillCount: countSkillFiles(skillRoots),
    skillRoots,
  };
}

function canRunPluginHooks(_loaded: LoadedPlugin): boolean {
  // Allow hooks from third-party marketplace plugins by default, matching built-in and official
  // plugins. This gives up the trust boundary that only official plugins can execute hooks, so
  // third-party plugin hooks will run directly. If trust needs to be configured per plugin later
  // (for example, through a user-configured allowlist), move the check back here.
  return true;
}

function warnUnsupportedComponents(loaded: LoadedPlugin, diagnostics: PluginDiagnostic[]): void {
  for (const key of UNSUPPORTED_COMPONENT_KEYS) {
    if (key in loaded.manifest) {
      diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
}

function resolveSkillRoots(
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): SkillRoot[] {
  warnEmptyDeclaredSkillRoots(input);
  return resolveComponentRoots("skills", input, priority);
}

/**
 * Emit a diagnostic when an explicitly declared skills path in the manifest has no usable skills,
 * so path configuration errors do not fail silently. Compute declarations independently of the
 * roots list to avoid false positives for an empty default skills/ directory. Keep actionable
 * diagnostics distinct for missing paths, empty directories, and symlink escapes; let the actual
 * scan path report permission errors.
 */
function warnEmptyDeclaredSkillRoots(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): void {
  const declared = parsePathList(input.loaded.manifest.skills);
  if (declared.length === 0) return;
  const seenPaths = new Set<string>();
  for (const rawPath of declared) {
    const resolved = resolveInside(input.loaded.rootPath, rawPath);
    if (!resolved || seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    // Treat a path as missing only for ENOENT/ENOTDIR (classified precisely by statSync). Do not
    // report permission errors such as EACCES as “missing”: there is not enough evidence, so skip this
    // warning and let the skill adapter emit skill_scan_failed when it scans the same directory.
    // Distinguish messages by cause: “path does not exist” means the manifest is misconfigured,
    // “exists but contains no skills” is a content issue, and “symlink escapes plugin root” is a
    // security rejection. Each requires a different fix; keep one code so the UI need not handle these
    // categories.
    if (isMissingPath(resolved)) {
      input.diagnostics.push({
        code: "plugin_skill_root_empty",
        message: `Plugin skills path does not exist: ${rawPath}`,
        path: resolved,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    // Trust boundary: declared paths are plugin content, and scanning does not follow symlinks
    // (reject directory- and file-level escapes, including Windows junctions). A symlinked root or
    // SKILL.md scans as empty and reaches the “no skills” warning below; do not misreport it as
    // “missing” because the lexical path exists.
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(resolved, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    if (skillFiles.length > 0) continue;
    input.diagnostics.push({
      code: "plugin_skill_root_empty",
      message: `Plugin skills path does not contain any skills: ${rawPath}`,
      path: resolved,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
}

function resolveCommandRoots(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot[] {
  const roots = resolveComponentRoots<CustomCommandRoot>(
    "commands",
    input,
    priority,
    createHookPluginContext(input.loaded, input.dataPath),
  );
  const generatedRoot = materializeCommandMetadataRoot(input, priority + 1);
  if (generatedRoot) roots.push(generatedRoot);
  return roots;
}

function inspectPluginHooks(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  runnable: boolean;
}): PluginHookInspection {
  const inspection = emptyHookInspection();
  for (const source of listPluginHookSources({
    diagnostics: input.diagnostics,
    loaded: input.loaded,
  })) {
    const loaded = parsePluginHookEvents({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      pluginDataPath: input.dataPath,
      rawHooks: source.rawHooks,
      runnable: input.runnable,
      sourcePath: source.sourcePath,
      wrapper: source.wrapper,
    });
    mergeHookInspection(inspection, loaded);
  }

  return inspection;
}

function parsePluginHookEvents(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  pluginDataPath: string;
  rawHooks: unknown;
  runnable: boolean;
  sourcePath: string;
  wrapper: boolean;
}): PluginHookInspection {
  const hooksRoot = input.wrapper
    ? isRecord(input.rawHooks)
      ? input.rawHooks.hooks
      : undefined
    : input.rawHooks;
  const inspection = emptyHookInspection();
  if (!isRecord(hooksRoot)) {
    input.diagnostics.push({
      code: "plugin_hook_invalid",
      message: input.wrapper
        ? "Plugin hooks file must contain a hooks object"
        : "Plugin manifest hooks entry must be an object, a path, or an array",
      path: input.sourcePath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return inspection;
  }

  const plugin = createHookPluginContext(input.loaded, input.pluginDataPath, input.sourcePath);
  for (const [eventName, matcherConfigs] of Object.entries(hooksRoot)) {
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
      input.diagnostics.push({
        code: "plugin_hook_unsupported_event",
        message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    if (!Array.isArray(matcherConfigs)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: `Plugin hook event must be an array: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const event = eventName as HookEventName;
    for (const matcherConfig of matcherConfigs) {
      const validation = HookMatcherConfigSchema.safeParse(matcherConfig);
      if (!validation.success) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Invalid plugin hook matcher for ${eventName}: ${validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          path: input.sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      const withPlugin: HookMatcherConfig = {
        ...validation.data,
        hooks: validation.data.hooks.map((hook) => attachPluginToHook(hook, plugin)),
      };
      (inspection.events[event] ??= []).push(withPlugin);
      for (const hook of validation.data.hooks) {
        inspection.details.push(
          toPluginHookDetail({
            event,
            hook,
            ...(validation.data.matcher !== undefined ? { matcher: validation.data.matcher } : {}),
            runnable: input.runnable,
            sourcePath: input.sourcePath,
          }),
        );
      }
    }
  }

  return inspection;
}

function toPluginHookDetail(input: {
  event: HookEventName;
  hook: HookConfig;
  matcher?: string;
  runnable: boolean;
  sourcePath: string;
}): PluginHookDetail {
  const detail: PluginHookDetail = {
    command: input.hook.command,
    event: input.event,
    runnable: input.runnable,
    sourcePath: input.sourcePath,
    type: input.hook.type,
  };
  if (input.matcher !== undefined) detail.matcher = input.matcher;
  if (input.hook.statusMessage !== undefined) detail.statusMessage = input.hook.statusMessage;
  if (input.hook.timeoutMs !== undefined) detail.timeoutMs = input.hook.timeoutMs;
  if (input.hook.type === "process") {
    if (input.hook.args !== undefined) detail.args = input.hook.args;
    return detail;
  }
  if (input.hook.async !== undefined) detail.async = input.hook.async;
  if (input.hook.shell !== undefined) detail.shell = input.hook.shell;
  if (input.hook.timeout !== undefined) detail.timeout = input.hook.timeout;
  return detail;
}

function createHookPluginContext(
  loaded: LoadedPlugin,
  dataPath: string,
  sourcePath?: string,
): HookPluginContext {
  return {
    dataPath,
    id: loaded.id,
    name: loaded.manifest.name,
    rootPath: loaded.rootPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function attachPluginToHook(hook: HookConfig, plugin: HookPluginContext): HookConfig {
  return {
    ...hook,
    plugin,
  };
}

function mergeHookEvents(
  target: Partial<Record<HookEventName, HookMatcherConfig[]>>,
  source: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): void {
  for (const [eventName, matchers] of Object.entries(source) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length > 0) {
      (target[eventName] ??= []).push(...matchers);
    }
  }
}

function mergeHookInspection(target: PluginHookInspection, source: PluginHookInspection): void {
  mergeHookEvents(target.events, source.events);
  target.details.push(...source.details);
}

function emptyHookInspection(): PluginHookInspection {
  return {
    details: [],
    events: {},
  };
}

function countSkillFiles(skillRoots: SkillRoot[]): number {
  // Skill recognition now uses the shared scan helper (a root containing SKILL.md is itself a skill). The declared
  // root and default skills/ root can find the same SKILL.md, so deduplicate by file path to avoid double-counting.
  // This also fixes drift: checking only isDirectory() omitted symlink skill directories, which the shared helper includes.
  // The helper swallows only ENOENT; permission errors (EACCES, etc.) are thrown. Preserve the existing behavior by
  // counting that root as 0 here; the skill adapter emits the skill_scan_failed diagnostic when it scans the same
  // directory at runtime. Trust boundary: consume only plugin roots (from resolveSkillRoots) and do not follow symlinks.
  const seenFiles = new Set<string>();
  for (const skillRoot of skillRoots) {
    try {
      for (const file of scanSkillFilesUnderRootSync(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
      })) {
        seenFiles.add(file);
      }
    } catch {
// Fall back to a count of 0 in the overview; the skill adapter handles scan diagnostics.
    }
  }
  return seenFiles.size;
}

function resolveComponentRoots<T extends CustomCommandRoot | SkillRoot>(
  key: "commands" | "skills",
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
  plugin?: HookPluginContext,
): T[] {
  const paths = parsePathList(input.loaded.manifest[key]);
  const defaultPath = join(input.loaded.rootPath, key);
  if (directoryExists(defaultPath)) {
    paths.unshift(key);
  }
  const roots: T[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = resolveInside(input.loaded.rootPath, rawPath);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin ${key} path escapes plugin root: ${rawPath}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    roots.push({
      path,
      ...(plugin ? { plugin } : {}),
      ...(key === "skills" ? { pluginId: input.loaded.id } : {}),
      priority,
      scope: input.loaded.source === "official" ? "system" : "user",
      source: "plugin",
    } as T);
  }
  return roots;
}

function materializeCommandMetadataRoot(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot | null {
  const spec = input.loaded.manifest.commands;
  if (!isRecord(spec)) return null;

  const generatedRoot = join(input.dataPath, "generated-commands");
  let wroteCommand = false;
  mkdirSync(generatedRoot, { recursive: true });

  for (const [rawName, rawMetadata] of Object.entries(spec)) {
    if (!isRecord(rawMetadata)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command metadata must be an object: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const name = normalizeGeneratedCommandName(rawName);
    if (!name) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Invalid plugin command name: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const source = typeof rawMetadata.source === "string" ? rawMetadata.source : undefined;
    const content = typeof rawMetadata.content === "string" ? rawMetadata.content : undefined;
    if ((source && content) || (!source && !content)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command '${rawName}' must provide exactly one of source or content`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    let markdown = content;
    if (source) {
      const sourcePath = resolveInside(input.loaded.rootPath, trimRelativePrefix(source));
      if (!sourcePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source escapes plugin root: ${source}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (!fileExists(sourcePath)) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source file not found: ${source}`,
          path: sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      markdown = readFileSync(sourcePath, "utf8");
    }
    if (markdown === undefined) continue;

    // The marketplace manifest supports a commands object mapping and inline content.
    // ZCode's custom command loader scans only Markdown roots, so materialize low-risk command content
    // in the plugin data directory. The generated path is not exposed outside the plugin root, and the
    // command itself is not executed.
    writeFileSync(
      join(generatedRoot, `${name}.md`),
      applyCommandMetadataFrontmatter(markdown, rawMetadata),
      "utf8",
    );
    wroteCommand = true;
  }

  return wroteCommand
    ? {
        path: generatedRoot,
        plugin: createHookPluginContext(input.loaded, input.dataPath),
        priority,
        scope: input.loaded.source === "official" ? "system" : "user",
        source: "plugin",
      }
    : null;
}

function normalizeGeneratedCommandName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

function trimRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "");
}

function applyCommandMetadataFrontmatter(
  markdown: string,
  metadata: Record<string, unknown>,
): string {
  const frontmatter = new Map<string, string>();
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    frontmatter.set("description", metadata.description.trim());
  }
  if (typeof metadata.argumentHint === "string" && metadata.argumentHint.trim()) {
    frontmatter.set("argument-hint", metadata.argumentHint.trim());
  }
  if (typeof metadata.model === "string" && metadata.model.trim()) {
    frontmatter.set("model", metadata.model.trim());
  }
  if (Array.isArray(metadata.allowedTools)) {
    const allowedTools = metadata.allowedTools
      .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim());
    if (allowedTools.length > 0) frontmatter.set("allowed-tools", allowedTools.join(", "));
  }
  if (frontmatter.size === 0) return markdown;
  const body = stripMarkdownFrontmatter(markdown).trimStart();
  return `---\n${Array.from(frontmatter, ([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;
}

function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return markdown;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(endIndex + 1).join("\n") : markdown;
}

function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
): string[] {
  // Upgrading official plugins preserves old version cache directories. If every directory is
  // traversed and the first match for a plugin id wins, an old version may load before the current
  // version referenced by the bundled marketplace. The bundled shard is the authoritative manifest
  // for assets shipped with the app; when present, load only its cachePath. Do not simply select the
  // highest semver, since that would still load an old cache after an official rollback.
  const bundledRoots = loadBundledOfficialPluginRootsSync(storageRoot);
  if (bundledRoots !== undefined) {
    for (const rootPath of bundledRoots) {
      throwIfAborted(options);
    }
    return bundledRoots;
  }

  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}

function loadPlugin(
  candidate: PluginCandidate,
  diagnostics: PluginDiagnostic[],
): LoadedPlugin | null {
  if (!directoryExists(candidate.rootPath)) {
    diagnostics.push({
      code: "plugin_root_not_found",
      message: `Plugin root does not exist: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "warning",
    });
    return null;
  }

  const manifestPath = findManifest(candidate.rootPath);
  if (!manifestPath) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "error",
    });
    return null;
  }

  const manifest = readManifest(manifestPath, diagnostics);
  if (!manifest) return null;
  return {
    id: `${manifest.name}@${candidate.marketplace}`,
    manifest,
    manifestPath,
    marketplace: candidate.marketplace,
    rootPath: candidate.rootPath,
    source: candidate.source,
  };
}

function findManifest(rootPath: string): string | null {
  const zcodePath = join(rootPath, ZCODE_MANIFEST_PATH);
  if (fileExists(zcodePath)) {
    return zcodePath;
  }

  // Support different manifest directory conventions by trying stable fallbacks during discovery.
  const claudePath = join(rootPath, CLAUDE_MANIFEST_PATH);
  if (fileExists(claudePath)) {
    return claudePath;
  }
  const codexPath = join(rootPath, CODEX_MANIFEST_PATH);
  return fileExists(codexPath) ? codexPath : null;
}

function readManifest(path: string, diagnostics: PluginDiagnostic[]): PluginManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      ...parsed,
      name,
      version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
    } as PluginManifest;
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : `Invalid plugin manifest: ${path}`,
      path,
      severity: "error",
    });
    return null;
  }
}

function emptyOutcome(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

function emptyComponents(hookDetails: PluginHookDetail[] = []): PluginComponents {
  return {
    commandRoots: [],
    hooks: {},
    hookDetails,
    mcpServers: {},
    skillCount: 0,
    skillRoots: [],
  };
}

function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}
