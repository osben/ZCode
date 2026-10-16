/**
 * Pure helpers for the ACP agents settings panel: form ⇄ config translation
 * and the synthetic model configuration stored for an ACP provider.
 */
import type { AcpAgentSummary } from "@zcode/services";
import type { ModelConfigObject, ProviderConfigObject } from "@zcode/provider";

export const ACP_PROVIDER_ID_PREFIX = "acp:";

export function acpProviderId(agentId: string): string {
  return `${ACP_PROVIDER_ID_PREFIX}${agentId}`;
}

export function isAcpProviderId(providerId: string): boolean {
  return providerId.startsWith(ACP_PROVIDER_ID_PREFIX);
}

export interface AcpAgentFormValues {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function defaultAcpAgentFormValues(agent: AcpAgentSummary): AcpAgentFormValues {
  return {
    command: agent.commandPath ?? "",
    args: [...agent.spawnArgs],
    env: {},
  };
}

export function splitAcpArgs(text: string): string[] {
  return text.trim().length === 0 ? [] : text.trim().split(/\s+/);
}

export function joinAcpArgs(args: readonly string[]): string {
  return args.join(" ");
}

/** Parses `KEY=VALUE` lines; invalid lines are reported instead of silently dropped. */
export function parseAcpEnvLines(text: string): {
  env: Record<string, string>;
  invalidLines: string[];
} {
  const env: Record<string, string> = {};
  const invalidLines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      invalidLines.push(line);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalidLines.push(line);
      continue;
    }
    env[key] = line.slice(separator + 1).trim();
  }
  return { env, invalidLines };
}

export function formatAcpEnvLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export type AcpAgentAccessConfigObject = NonNullable<ProviderConfigObject["access"]>;

/** Builds the access config saved on the `acp:<agentId>` personal provider. */
export function buildAcpAgentAccess(
  agent: AcpAgentSummary,
  form: AcpAgentFormValues,
): AcpAgentAccessConfigObject {
  const command = form.command.trim().length > 0 ? form.command.trim() : (agent.commandPath ?? "");
  const envEntries = Object.entries(form.env);
  return {
    type: "acp-agent",
    agentId: agent.agentId,
    command,
    args: [...form.args],
    ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
  };
}

/**
 * Context windows: opencode reports 262144 via `usage_update`; cursor uses a
 * placeholder until real numbers are observed.
 */
const ACP_CONTEXT_WINDOW_BY_AGENT: Record<string, number> = {
  opencode: 262144,
  cursor: 200000,
};
const DEFAULT_ACP_CONTEXT_WINDOW = 200000;

/**
 * Complete synthetic model config for the ACP pseudo-model, mirroring the
 * shape the provider resolver expects (every system leaf present, a singular
 * "auto" reasoning level and a no-op option map).
 */
export function buildAcpPseudoModelConfig(agentId: string): ModelConfigObject {
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: ACP_CONTEXT_WINDOW_BY_AGENT[agentId] ?? DEFAULT_ACP_CONTEXT_WINDOW,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["auto"], default: "auto", map: "{}" },
      maxOutputTokens: { max: 32000, map: "{}" },
    },
  };
}
