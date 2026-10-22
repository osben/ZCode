/**
 * Pure helpers for the ACP agents section of Model Settings: form ⇄ config
 * translation, the synthetic model configuration of an ACP provider, and the
 * navigation group that lists detected agents.
 */
import type { AcpAgentSummary } from "@zcode/services";
import type { ModelConfigObject, ProviderConfigObject } from "@zcode/provider";
import type { ModelProviderNavGroup } from "./constants.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

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

/** Selection key prefix of an ACP agent navigation row. */
export const ACP_AGENT_NODE_KEY_PREFIX = "acp-agent:";
export const ACP_DETECT_NODE_KEY = "acp-detect";
export const ACP_LOADING_NODE_KEY = "acp-loading";

export function acpAgentNodeKey(agentId: string): string {
  return `${ACP_AGENT_NODE_KEY_PREFIX}${agentId}`;
}

export function isAcpNodeKey(key: string | null): boolean {
  return (
    key !== null &&
    (key.startsWith(ACP_AGENT_NODE_KEY_PREFIX) ||
      key === ACP_DETECT_NODE_KEY ||
      key === ACP_LOADING_NODE_KEY)
  );
}

/**
 * Static facts the UI adds to a known agent. The detection contract only
 * reports a binary path once the agent is installed, so the probed binary
 * name and the documentation page live here. `binary` must match
 * `ACP_AGENT_DEFINITIONS` in `@zcode/acp-agent-runtime`.
 */
export interface AcpAgentCatalogEntry {
  readonly binary: string;
  readonly docsUrl: string;
}

export const ACP_AGENT_CATALOG: Readonly<Record<string, AcpAgentCatalogEntry>> = {
  opencode: { binary: "opencode", docsUrl: "https://opencode.ai/docs/" },
  cursor: { binary: "cursor-agent", docsUrl: "https://cursor.com/docs/cli/overview" },
};

/** Detection state as the settings page consumes it (one owner: the detection hook). */
export interface AcpDetectionState {
  readonly status: "loading" | "ready" | "error";
  /** Every known agent, installed or not; empty when the scan failed without a previous result. */
  readonly agents: readonly AcpAgentSummary[];
  /** False when this environment cannot run ACP agents at all. */
  readonly supported: boolean;
  /** A rescan is in flight; the previous agents stay visible. */
  readonly refreshing: boolean;
  readonly error?: string;
}

export interface AcpNavigationGroupInput {
  /** Dev-only gate (`isLocalDevelopmentRuntime`); false means no group at all. */
  readonly enabled: boolean;
  readonly title: string;
  readonly detectLabel: string;
  readonly detectingLabel: string;
  readonly detection: AcpDetectionState;
  /** Provider ids (`acp:<agentId>`) that are ACP-managed and enabled. */
  readonly enabledProviderIds: ReadonlySet<string>;
  /** Agent ids that have an ACP-managed provider, enabled or not. Kept listed even when uninstalled so they can be disabled. */
  readonly managedAgentIds: ReadonlySet<string>;
  /** Agent ids whose `acp:<agentId>` id is taken by a non-ACP provider. */
  readonly conflictAgentIds: ReadonlySet<string>;
}

/**
 * Builds the "ACP agents" navigation group placed after the custom group.
 * Installed agents are one row each; otherwise a single loading row (first
 * scan in flight) or a "detect agents" row (empty or failed) opens the catalog.
 */
export function buildAcpNavigationGroup(
  input: AcpNavigationGroupInput,
): ModelProviderNavGroup | null {
  if (!input.enabled) return null;
  // Installed agents are listed; an uninstalled agent stays listed only while it has an ACP-managed provider.
  const listed = input.detection.agents.filter(
    (agent) => agent.installed || input.managedAgentIds.has(agent.agentId),
  );
  if (listed.length > 0) {
    return {
      id: "acp",
      title: input.title,
      items: listed.map((agent) => {
        const enabled = input.enabledProviderIds.has(acpProviderId(agent.agentId));
        const conflict = input.conflictAgentIds.has(agent.agentId);
        return {
          key: acpAgentNodeKey(agent.agentId),
          type: "acpAgent" as const,
          label: agent.displayName,
          agentId: agent.agentId,
          agent,
          installed: agent.installed,
          enabled,
          conflict,
          statusActive:
            resolveAcpAgentStatusKind({ enabled, installed: agent.installed, conflict }) ===
            "ready",
        };
      }),
    };
  }
  if (input.detection.status === "loading") {
    return {
      id: "acp",
      title: input.title,
      items: [{ key: ACP_LOADING_NODE_KEY, type: "acpLoading", label: input.detectingLabel }],
    };
  }
  return {
    id: "acp",
    title: input.title,
    items: [
      {
        key: ACP_DETECT_NODE_KEY,
        type: "acpDetect",
        label: input.detectLabel,
        detection: input.detection.status === "error" ? "error" : "empty",
      },
    ],
  };
}

/** Status dot of an ACP agent row; shared by the navigation row and the detail header. */
export type AcpAgentStatusKind = "disabled" | "unavailable" | "ready";

/**
 * One rule for both navigation and detail: ready when enabled, installed and
 * not in conflict; unavailable when enabled but the CLI is missing; otherwise
 * disabled.
 */
export function resolveAcpAgentStatusKind(input: {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly conflict: boolean;
}): AcpAgentStatusKind {
  if (input.enabled && input.installed && !input.conflict) return "ready";
  if (input.enabled && !input.installed) return "unavailable";
  return "disabled";
}

/**
 * True for a personal provider this section manages: the `acp:` id together
 * with the `acp-agent` access type. A same-id provider with another access
 * type is a conflict, not an ACP provider.
 */
export function isAcpManagedProvider(provider: ProviderSettingsFormProvider): boolean {
  return isAcpProviderId(provider.providerId) && provider.config.access?.type === "acp-agent";
}

/** Providers without ACP-managed entries; used for display order so `acp:` ids never reach the shared order. */
export function withoutAcpManagedProviders(
  providers: readonly ProviderSettingsFormProvider[],
): ProviderSettingsFormProvider[] {
  return providers.filter((provider) => !isAcpManagedProvider(provider));
}

/**
 * Overlay that switches an ACP provider off. It carries the saved access back
 * in the same write: the overlay save replaces the config it is given, so a
 * bare `enabled: false` would drop the command, args and env. Returns null for
 * a provider this section does not own.
 */
export function buildAcpDisableOverlay<A extends { readonly type: string }>(
  access: A | null | undefined,
): { readonly access: A } | null {
  return access?.type === "acp-agent" ? { access } : null;
}
