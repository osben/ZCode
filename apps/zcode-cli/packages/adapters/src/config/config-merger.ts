// Config Merger - Merge configs by priority

import type {
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, ConfigScopePriority } from "@zcode/contracts";

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  config: RuntimeConfigPatch;
  scope: ConfigScope;
  priority: number;
}

/**
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  const result: RuntimeConfigPatch = {};

  for (const { config: inputConfig, scope } of sorted) {
    const config =
      scope === ConfigScope.Project && inputConfig.plugins
        ? (() => {
            // Marketplace is directory configuration for the Host User inventory, not Workspace project configuration.
            // Keep the schema for compatibility with older files, but do not let project-level fields enter the merged RuntimeConfig/catalog.
            const projectPlugins = { ...inputConfig.plugins };
            delete projectPlugins.extraKnownMarketplaces;
            return { ...inputConfig, plugins: projectPlugins };
          })()
        : inputConfig;
    const previousHooks = result.hooks;
    const previousPlugins = result.plugins;
    Object.assign(result, config);

    // Deep merge nested objects
    if (config.modelStream) {
      result.modelStream = { ...result.modelStream, ...config.modelStream };
    }
    if (config.permission) {
      result.permission = { ...result.permission, ...config.permission };
    }
    if (config.storage) {
      result.storage = { ...result.storage, ...config.storage };
    }
    if (config.network) {
      result.network = { ...result.network, ...config.network };
    }
    if (config.features) {
      result.features = { ...result.features, ...config.features };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.mcp) {
      result.mcp = {
        ...result.mcp,
        ...config.mcp,
        servers: {
          ...result.mcp?.servers,
          ...config.mcp.servers,
        },
      };
    }
    if (config.plugins) {
      // Workspace Plugin and User Plugin settings share one RuntimeConfig. Do not let the later `plugins` object
      // replace the earlier source wholesale; otherwise a Workspace declaring one plugin would discard other enabled
      // User plugins and options. Merge enabledPlugins by pluginId and options by pluginId/option key; retain candidate
      // roots from both layers in dirs, then let the final resolver deduplicate and validate paths.
      result.plugins = {
        // Object.assign has already pointed result.plugins at the current higher-priority layer. Spreading only
        // result.plugins here would discard the User layer's dirs when Workspace specifies only options, so the next
        // configure could not even discover the plugin. Build explicitly from previousPlugins.
        ...previousPlugins,
        ...config.plugins,
        ...(config.plugins.dirs
          ? {
              dirs: [...new Set([...(previousPlugins?.dirs ?? []), ...config.plugins.dirs])],
            }
          : {}),
        ...(config.plugins.enabledPlugins
          ? {
              enabledPlugins: {
                ...previousPlugins?.enabledPlugins,
                ...config.plugins.enabledPlugins,
              },
            }
          : {}),
        ...(config.plugins.extraKnownMarketplaces
          ? {
              extraKnownMarketplaces: {
                ...previousPlugins?.extraKnownMarketplaces,
                ...config.plugins.extraKnownMarketplaces,
              },
            }
          : {}),
        ...(config.plugins.options
          ? {
              options: mergePluginOptions(previousPlugins?.options, config.plugins.options),
            }
          : {}),
      };
    }
    if (config.skills) {
      result.skills = {
        ...result.skills,
        ...config.skills,
      };
    }
    if (config.skillOverrides) {
      result.skillOverrides = {
        ...result.skillOverrides,
        ...config.skillOverrides,
      };
    }
    if (config.commandOverrides) {
      result.commandOverrides = {
        ...result.commandOverrides,
        ...config.commandOverrides,
      };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.toolConcurrency) {
      result.toolConcurrency = { ...result.toolConcurrency, ...config.toolConcurrency };
    }
    if (config.modelAnomalyGuard) {
      result.modelAnomalyGuard = {
        ...result.modelAnomalyGuard,
        ...config.modelAnomalyGuard,
      };
    }
    if (config.hooks) {
      result.hooks = mergeHooksConfig(previousHooks, config.hooks);
    }
    if (config.ui) {
      result.ui = { ...result.ui, ...config.ui };
    }
  }

  return result;
}

function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...(current ?? {}) };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...(merged[pluginId] ?? {}),
      ...options,
    };
  }
  return merged;
}

function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // Project hooks must not replace User hooks wholesale, and an empty project `enabled:false` must not disable
  // User hooks. Each config file controls only its own events, so append events only when that source is enabled;
  // effective enabled is determined by whether either source is enabled.
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * Get priority for a config scope
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
