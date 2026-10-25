import type { CustomCommandRoot } from "../commands/index.js";
import type { HookEventName, HookMatcherConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { ResolvedLspServer } from "../lsp/index.js";
import type { SkillRoot } from "../skills/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE = "claude-plugins-official";
export const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
export const ZCODE_PLUGIN_HOST_COMMAND = "__zcode-plugin-host";
/**
 * Hidden subcommand: entry point for the dynamic workflow sandbox subprocess
 * (`__zcode-dwf-child <entry path>`; the last argv item is the entry file path written by the
 * harness, and the payload does not pass through the command line).
 *
 * Same family and mechanism as {@link ZCODE_PLUGIN_HOST_COMMAND}: a single-file SEA binary
 * does not interpret Node CLI flags, so the harness's default `node --max-old-space-size=…
 * <entry>` spawn would inevitably fail when strict parseArgs receives the flags. Under SEA,
 * re-execute this binary and dispatch in `run.ts` **before** parseArgs.
 * Keep the constant in contracts rather than dynamic-workflow-runtime: the latter deliberately
 * does not depend on contracts (to prove it is app-free). After detecting SEA, bootstrap passes
 * it to the harness as argsPrefix.
 */
export const ZCODE_DWF_CHILD_COMMAND = "__zcode-dwf-child";

export function isOfficialMarketplaceId(id: string): boolean {
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE || id === CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE;
}

export type PluginSource = "official" | "inline" | "cache";
export type PluginDiagnosticSeverity = "warning" | "error";

export type PluginDiagnosticCode =
  | "plugin_root_not_found"
  | "plugin_manifest_not_found"
  | "plugin_manifest_invalid"
  | "plugin_component_path_invalid"
  | "plugin_unsupported_component"
  | "plugin_skill_root_empty"
  | "plugin_mcp_read_failed"
  | "plugin_mcp_invalid"
  | "plugin_mcp_server_disabled"
  | "plugin_hook_read_failed"
  | "plugin_hook_invalid"
  | "plugin_hook_unsupported_event"
  | "plugin_dependency_invalid"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_dependency_cross_marketplace"
  | "plugin_marketplace_invalid"
  | "plugin_marketplace_declaration_reserved"
  | "plugin_git_unavailable"
  | "plugin_archive_fetch_failed"
  | "plugin_marketplace_source_unsupported"
  | "plugin_validation_deferred"
  | "plugin_variable_missing"
  | "plugin_duplicate_id"
  | "plugin_not_found"
  | "plugin_ambiguous_name"
  | "lsp_config_invalid"
  | "lsp_extension_shadowed";

export interface PluginUserConfigOption {
  default?: string | number | boolean;
  description?: string;
  title?: string;
  required?: boolean;
  sensitive?: boolean;
  type?: "string" | "number" | "boolean" | "directory" | "file";
}

export type PluginOptionValue = string | number | boolean;
export type PluginOptionValues = Record<string, PluginOptionValue>;

export type PluginMarketplaceSourceConfig =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string };

export interface PluginMarketplaceConfig {
  source: PluginMarketplaceSourceConfig;
}

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: HookEventName;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

/** Component groups for the detail UI, in display order: agent / command / skill / hook / mcp. */
export type PluginComponentKind = "agent" | "command" | "skill" | "hook" | "mcp" | "lsp";

export interface PluginComponentItem {
  name: string;
  /** Description from the component frontmatter / manifest; omitted when missing, never fabricated. */
  description?: string;
}

export interface PluginComponentGroup {
  kind: PluginComponentKind;
  items: PluginComponentItem[];
}

/**
 * Store Listing information: display metadata carried by a marketplace catalog entry,
 * describing how it appears in the store without affecting plugin behavior. All fields are
 * optional; when missing, the UI follows its fallback matrix (letter avatar / hidden section /
 * omitted information row).
 */
export interface PluginStoreListing {
  /** Name shown on the card/detail page; falls back to the plugin name slug when missing. */
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  /** Localized versions of the catalog entry description (the base description has its own field). */
  descriptionI18n?: Record<string, string>;
  /** Icon image: an HTTPS URL or a local asset path for a built-in plugin. */
  icon?: string;
  category?: string;
  /** 官方市场内的维护归属；不参与执行权限和安装来源判定。 */
  publisherType?: "official" | "community";
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  /** Hero banner image for the detail page. */
  heroImage?: string;
  /** Example prompt chips on the detail page; clicking one starts a session with it prefilled. */
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
   * Requires a paid plan for full use: the catalog entry declares `requiresPaidPlan: true`,
   * and the store card and detail page show an indicator beside the title. This describes a
   * usage requirement, not a paid plugin product, so it does not affect installation gates or
   * billing. The name is not tied to a specific plan product, so renaming a plan will not make
   * this field stale.
   */
  requiresPaidPlan?: boolean;
}

export interface PluginManifest {
  agents?: unknown;
  author?: unknown;
  channels?: unknown;
  commands?: unknown;
  dependencies?: unknown;
  description?: string;
  homepage?: string;
  hooks?: unknown;
  keywords?: unknown;
  license?: string;
  lspServers?: unknown;
  mcpServers?: unknown;
  name: string;
  outputStyles?: unknown;
  repository?: string;
  settings?: unknown;
  skills?: unknown;
  /** Plugin UI: panel entry declarations in `ui.surfaces[]`, parsed by adapters. */
  ui?: unknown;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

/** Panel lifecycle: only session scope is accepted in the first version; enable `draft` scope if needed later. */
export type PluginUiSurfaceAvailability = "session";
/** Title: a single string or a map keyed by locale (for example `{ "zh-CN": "...", "en-US": "..." }`). */
export type PluginUiSurfaceTitle = string | Record<string, string>;
export interface PluginUiSurfaceDefinition {
  id: string;
  title: PluginUiSurfaceTitle;
  icon?: string;
  /** Runtime namespaced MCP server name (`plugin:${name}:${server}`), used directly by the UI for mcp/uiReadResource. */
  server: string;
  /** Original server key declared in the manifest, for diagnostics and display only. */
  declaredServer: string;
  /** Must begin with `ui://`. */
  resourceUri: string;
  availability: PluginUiSurfaceAvailability;
}

export interface PluginConfig {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, PluginMarketplaceConfig>;
  options: Record<string, PluginOptionValues>;
  suppressedBuiltins: string[];
}

export interface PluginMetadata {
  /** Author name from the manifest (plugin.json), normalized to a string; used as the detail-page fallback when store listing info is missing. */
  author?: string;
  authorUrl?: string;
  commandRootCount: number;
  /**
   * Authoritative component inventory (name + optional description), enumerated from the
   * plugin root by the loader during parsing and independent of enabled state. The detail UI
   * displays it directly without joining Skills/Commands/Agents in the UI.
   */
  components: PluginComponentGroup[];
  configuredOptions?: PluginOptionValues;
  dataPath: string;
  declaredMcpServerNames: string[];
  /** Language server names declared by a valid entry (`.lsp.json` or manifest), enabled or not. */
  lspServerNames: string[];
  description?: string;
  enabled: boolean;
  /** homepage from the manifest (plugin.json); used as the detail-page fallback when store listing info is missing. */
  homepage?: string;
  id: string;
  manifestPath: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  hookDetails: PluginHookDetail[];
  rootPath: string;
  skillCount: number;
  skillRootCount: number;
  source: PluginSource;
  /** Parsed and validated `ui.surfaces[]` manifest entries; absent when undeclared or all entries are invalid. */
  uiSurfaces?: PluginUiSurfaceDefinition[];
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

// ============================================================
// Identity catalog contract for Plugin conversation references (@ Plugin capability hints).
// Semantics: the catalog is frozen when the Session (App) is created and carries only identity
// and capability declarations; capabilities actually injected each turn are intersected with
// the live inventory.
// ============================================================

export interface PluginReferenceCatalogEntry {
  /** Stable Plugin ID: `${manifest.name}@${marketplace}`, the unique identity of a canonical plugin:// link. */
  pluginId: string;
  /** manifest name (base of the Skill/MCP/Subagent runtime namespaces), only for display and provenance matching; not authoritative. */
  name: string;
  marketplace: string;
  /** Enabled state when the catalog was frozen; disabled entries remain for `disabled_in_session` diagnostics but cannot be referenced. */
  enabled: boolean;
  /**
   * Other enabled Plugin stable IDs that share this entry's manifest.name.
   * A non-empty list is a V1 fail-closed conflict: the Picker disables selection, and runtime
   * skips it as ambiguous. Do not use last-write-wins or guess from the display name.
   */
  conflictingPluginIds: string[];
  /** Qualified Skill names declared by identity (`${name}:${skill}`); from component enumeration and independent of live discovery. */
  skillQualifiedNames: string[];
  /** Namespaced MCP server names declared by identity (`plugin:${name}:${server}`). */
  mcpServerNames: string[];
  /** Canonical Subagent names declared by identity (`${name}:${agent}`); from component enumeration. */
  subagentNames: string[];
  /**
   * Plugin root directory, used only by runtime to trace provenance for live Skill/Subagent
   * entries (rootPath prefix check). Do not include it in provider reminders or protocol
   * projections; paths are outside this identifiers-only contract.
   */
  rootPath: string;
  /** Panel entry declaration (A5); lets the host look up panel definitions in the session's frozen catalog. */
  uiSurfaces?: PluginUiSurfaceDefinition[];
}

export interface PluginReferenceCatalog {
  plugins: PluginReferenceCatalogEntry[];
}

export interface PluginLoadOutcome {
  commandRoots: CustomCommandRoot[];
  diagnostics: PluginDiagnostic[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
  /** Language servers of enabled plugins, templates expanded and extension conflicts resolved. */
  lspServers: ResolvedLspServer[];
  /** Store listing is associated by full Plugin ID for CLI/TUI display; not used for runtime identity checks. */
  pluginListingsById?: Record<string, PluginStoreListing>;
  plugins: PluginMetadata[];
  skillRoots: SkillRoot[];
}

export interface PluginDiscoverRequest {
  config: PluginConfig;
  env?: Record<string, string | undefined>;
  // Bootstrap may pass a list of official plugin ids that are safe to enable by default, so
  // users can use them without first running `zcode plugins enable` (for example, the content-
  // only skill-creator). Defaults to an empty set, preserving current behavior for all plugins,
  // including resource-heavy ones such as ios-simulator/android-emulator.
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  officialPluginRoots?: string[];
  storageRoot: string;
  trace?: TraceContext;
  workingDirectory: string;
}

export interface PluginOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface PluginPort {
  discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome>;
}
