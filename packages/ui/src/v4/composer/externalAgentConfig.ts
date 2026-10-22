/**
 * Composer view of an external ACP agent's session options (specs/acp-agent-runtime.md "S6", "UI (as
 * shipped)"). Pure helpers: the projection (`config.externalAgentConfig`) owns the values; the composer
 * only reads them and sends `setExternalAgentConfigOption`.
 */
import { ACP_PROVIDER_ID_PREFIX } from "@zcode/provider";
import type {
  CommandAck,
  CommandType,
  ExternalAgentConfigOption,
  ExternalAgentConfigState,
  ExternalAgentConfigValue,
} from "@zcode/shared/zcode-protocol-v4";

export const TID_EXTERNAL_AGENT_CONFIG_TRIGGER = "external-agent-config-trigger";
export const TID_EXTERNAL_AGENT_CONFIG_ITEM = "external-agent-config-item";
export const TID_EXTERNAL_AGENT_CONFIG_SEARCH = "external-agent-config-search";
export const TID_EXTERNAL_AGENT_CONFIG_HINT = "external-agent-config-hint";

/** A select with more values than this gets a filter input inside its menu. */
export const EXTERNAL_AGENT_CONFIG_SEARCH_THRESHOLD = 8;

export type ExternalAgentControlKind = "mode" | "model" | "effort";

export const EXTERNAL_AGENT_CONTROL_KINDS: readonly ExternalAgentControlKind[] = [
  "mode",
  "model",
  "effort",
];

/** The agent id of an `acp:<agentId>` provider, or null for any other provider. */
export function resolveExternalAgentId(providerId: string | null | undefined): string | null {
  if (!providerId?.startsWith(ACP_PROVIDER_ID_PREFIX)) return null;
  const agentId = providerId.slice(ACP_PROVIDER_ID_PREFIX.length);
  return agentId.length > 0 ? agentId : null;
}

const CONTROL_CATEGORY: Record<ExternalAgentControlKind, string> = {
  mode: "mode",
  model: "model",
  effort: "thought_level",
};

const CONTROL_ID: Record<ExternalAgentControlKind, string> = {
  mode: "mode",
  model: "model",
  effort: "effort",
};

const KNOWN_CATEGORIES = new Set(Object.values(CONTROL_CATEGORY));

export type ExternalAgentComposerOptions = Partial<
  Record<ExternalAgentControlKind, ExternalAgentConfigOption>
>;

/**
 * Picks the options the composer shows: by category first, then by id for an option whose category
 * names no other control. Options without values and other selects are not shown in S6.
 */
export function selectExternalAgentComposerOptions(
  options: readonly ExternalAgentConfigOption[],
): ExternalAgentComposerOptions {
  const offered = options.filter((option) => option.options.length > 0);
  const result: ExternalAgentComposerOptions = {};
  for (const kind of EXTERNAL_AGENT_CONTROL_KINDS) {
    const option =
      offered.find((candidate) => candidate.category === CONTROL_CATEGORY[kind]) ??
      offered.find(
        (candidate) =>
          candidate.id === CONTROL_ID[kind] &&
          (candidate.category === null || !KNOWN_CATEGORIES.has(candidate.category)),
      );
    if (option) result[kind] = option;
  }
  return result;
}

export interface ExternalAgentComposerState {
  agentId: string;
  /** Null while the controls are disabled ("available after the first message"). */
  options: ExternalAgentComposerOptions | null;
}

/**
 * Composer state for the draft's model. Null when the model is not an ACP agent (the ZCode mode switch
 * renders). The options are enabled only when the server would accept a choice: the session exists,
 * the projection belongs to this agent and the session's own model is this agent.
 */
export function resolveExternalAgentComposerState(params: {
  draftProviderId: string | null | undefined;
  sessionId: string | null | undefined;
  sessionProviderId: string | null | undefined;
  projection: ExternalAgentConfigState | null | undefined;
}): ExternalAgentComposerState | null {
  const agentId = resolveExternalAgentId(params.draftProviderId);
  if (!agentId) return null;
  const enabled =
    Boolean(params.sessionId) &&
    params.projection?.agentId === agentId &&
    resolveExternalAgentId(params.sessionProviderId) === agentId;
  return {
    agentId,
    options: enabled ? selectExternalAgentComposerOptions(params.projection!.options) : null,
  };
}

/** The value after the current one, wrapping; the first value when the current one is unknown. */
export function nextExternalAgentConfigValue(option: ExternalAgentConfigOption): string | null {
  if (option.options.length === 0) return null;
  const index = option.options.findIndex((value) => value.value === option.currentValue);
  return option.options[(index + 1) % option.options.length]?.value ?? null;
}

export function currentExternalAgentConfigValue(
  option: ExternalAgentConfigOption,
): ExternalAgentConfigValue | null {
  return option.options.find((value) => value.value === option.currentValue) ?? null;
}

export function filterExternalAgentConfigValues(
  values: readonly ExternalAgentConfigValue[],
  query: string,
): ExternalAgentConfigValue[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...values];
  return values.filter((value) => value.name.toLocaleLowerCase().includes(needle));
}

/** Toast message id for a refused choice. */
export function externalAgentConfigRefusalMessageId(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case "config.notAvailable":
      return "chat.toolbar.externalAgent.error.notAvailable";
    case "config.invalid":
      return "chat.toolbar.externalAgent.error.invalid";
    case "config.notExternalAgent":
      return "chat.toolbar.externalAgent.error.notExternalAgent";
    default:
      return "chat.toolbar.externalAgent.error.failed";
  }
}

type DispatchExternalAgentConfigCommand = (
  type: Extract<CommandType, "setExternalAgentConfigOption">,
  payload: { sessionId: string; configId: string; value: string },
  targetSessionId: string,
) => Promise<CommandAck>;

/**
 * Sends one choice. Resolves to the toast message id to show, or null when nothing should be shown
 * (accepted, or a no-op such as `config.unchanged`). Never rejects.
 */
export async function sendExternalAgentConfigOption(
  dispatch: DispatchExternalAgentConfigCommand,
  sessionId: string,
  configId: string,
  value: string,
  onFailure?: (detail: { reasonCode: string; status: string }) => void,
): Promise<string | null> {
  try {
    const ack = await dispatch(
      "setExternalAgentConfigOption",
      { sessionId, configId, value },
      sessionId,
    );
    if (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate") {
      return null;
    }
    onFailure?.({ reasonCode: ack.reasonCode ?? "", status: ack.status });
    return externalAgentConfigRefusalMessageId(ack.reasonCode);
  } catch (error) {
    onFailure?.({
      reasonCode: error instanceof Error ? error.message : String(error),
      status: "transport_error",
    });
    return externalAgentConfigRefusalMessageId(undefined);
  }
}
