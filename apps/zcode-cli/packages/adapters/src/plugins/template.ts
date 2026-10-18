import type { PluginManifest, PluginOptionValues } from "@zcode/contracts";
import { isPluginOptionValue } from "./helpers.js";
import type { LoadedPlugin } from "./types.js";

// Shared `${...}` template resolver for plugin-declared runtime config (MCP stdio/http servers and
// language servers). Keep one implementation so both surfaces expand the same aliases with the
// same sensitivity rules.
const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface VariableContext {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  userConfigDefaults: PluginOptionValues;
  workingDirectory: string;
}

export function createVariableContext(input: {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): VariableContext {
  return {
    dataPath: input.dataPath,
    env: input.env,
    loaded: input.loaded,
    options: input.options,
    userConfigDefaults: getUserConfigDefaults(input.loaded.manifest),
    workingDirectory: input.workingDirectory,
  };
}

function getUserConfigDefaults(manifest: PluginManifest): PluginOptionValues {
  const defaults: PluginOptionValues = {};
  for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
    if (isPluginOptionValue(option.default)) defaults[key] = option.default;
  }
  return defaults;
}

/**
 * Plugin identity variables injected into the environment of every plugin-launched process. The
 * manifest `env` is spread after these, so a manifest can add variables but these paths stay
 * authoritative for the runtime that launched the process.
 */
export function buildPluginEnvBase(context: VariableContext): Record<string, string> {
  return {
    CLAUDE_PROJECT_DIR: context.workingDirectory,
    ZCODE_PLUGIN_DATA: context.dataPath,
    ZCODE_PLUGIN_ROOT: context.loaded.rootPath,
    ZCODE_PROJECT_DIR: context.workingDirectory,
    CLAUDE_PLUGIN_DATA: context.dataPath,
    CLAUDE_PLUGIN_ROOT: context.loaded.rootPath,
  };
}

export function resolveStringRecord(
  record: Record<string, unknown>,
  context: VariableContext,
  options: { allowSensitive: boolean },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = resolveTemplate(value, context, options);
  }
  return result;
}

export function resolveTemplate(
  value: string,
  context: VariableContext,
  options: { allowSensitive: boolean },
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    switch (name) {
      case "CLAUDE_PLUGIN_ROOT":
      case "ZCODE_PLUGIN_ROOT":
        return context.loaded.rootPath;
      case "CLAUDE_PLUGIN_DATA":
      case "ZCODE_PLUGIN_DATA":
        return context.dataPath;
      case "CLAUDE_PROJECT_DIR":
      case "ZCODE_PROJECT_DIR":
        return context.workingDirectory;
      case "CLAUDE_CODE_SESSION_ID":
      case "CLAUDE_SESSION_ID":
      case "ZCODE_SESSION_ID":
        throw new PluginVariableError(
          `Plugin variable requires a runtime session context: ${name}`,
        );
      case "CLAUDE_SKILL_DIR":
      case "ZCODE_SKILL_DIR":
        throw new PluginVariableError(`Plugin variable requires a skill context: ${name}`);
      default:
        break;
    }

    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      if (
        context.loaded.manifest.userConfig?.[key]?.sensitive === true &&
        !options.allowSensitive
      ) {
        throw new PluginVariableError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`,
        );
      }
      const configValue = context.options[key] ?? context.userConfigDefaults[key];
      if (configValue === undefined) {
        throw new PluginVariableError(`Missing plugin user_config value: ${key}`);
      }
      return String(configValue);
    }
    if (name.startsWith("ZCODE_")) {
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }
    if (options.allowSensitive && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      // Resolve the token only at the sensitive sink so the secret is not expanded into args, a URL, or
      // another visible field.
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }

    return match;
  });
}

export class PluginVariableError extends Error {}
