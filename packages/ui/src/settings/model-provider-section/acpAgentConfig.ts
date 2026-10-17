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

/** Access values of an enabled `acp:<agentId>` provider (form prefill). */
export interface AcpSavedAccess {
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

/**
 * Splits the arguments field with shell-like quoting: quoted whitespace stays
 * inside one argument and quote characters are removed (a lone empty quoted
 * string yields an empty argument).
 */
export function splitAcpArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasContent = false;
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (hasContent || current.length > 0) args.push(current);
    current = "";
    hasContent = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      // Inside quotes only the quote character and the backslash itself are
      // escapable (matches what joinAcpArgs emits); other backslashes stay
      // literal so Windows paths survive unchanged.
      if (
        char === "\\" &&
        index + 1 < text.length &&
        (text[index + 1] === quote || text[index + 1] === "\\")
      ) {
        current += text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      index += 1;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    hasContent = true;
  }
  push();
  return args;
}

/**
 * Serializes arguments so {@link splitAcpArgs} round-trips them exactly:
 * whitespace, quotes, and backslashes are quoted/escaped, and an empty
 * argument becomes a lone `""`. Without this, a saved argument containing
 * whitespace (e.g. `John Doe`) silently splits into two arguments when the
 * form remounts.
 */
export function joinAcpArgs(args: readonly string[]): string {
  return args.map(quoteAcpArg).join(" ");
}

function quoteAcpArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"'\\]/.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
    // The separator and key are trimmed for validation, but the value is
    // taken verbatim from the raw line: an unchanged form must not rewrite a
    // saved value like `" abc "` into `"abc"`.
    const separator = rawLine.indexOf("=");
    if (separator <= 0) {
      invalidLines.push(line);
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalidLines.push(line);
      continue;
    }
    env[key] = rawLine.slice(separator + 1);
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
  // Always send the env map, including an empty one: overlay merging treats a
  // missing field as "unchanged", so clearing every row must be explicit.
  return {
    type: "acp-agent",
    agentId: agent.agentId,
    command,
    args: [...form.args],
    env: Object.fromEntries(Object.entries(form.env)),
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
