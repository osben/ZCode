import { join } from "node:path";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
} from "./official-plugin-definitions.js";

type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

export function resolvePluginRuntimeFeatures(
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  const browserUsePlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePlugin && !cuaPlugin) {
    return {};
  }
  return {
    // Node REPL has moved to a real MCP server; enable only BrowserControlPort injection here and do not register core's raw js* tools.
    ...(browserUsePlugin ? { browserUse: true } : {}),
    ...(browserUsePlugin
      ? { browserDocumentationRoot: join(browserUsePlugin.rootPath, "docs") }
      : {}),
    // CUA and Browser Use share the same stateless node_repl MCP server. Record only whether the CUA
    // SDK needs bootstrap to inject a broker. Do not set nodeRepl: that field re-registers the old raw
    // core js tools and projects the same tools through both MCP and core.
    ...(cuaPlugin ? { computerUse: true } : {}),
  };
}
