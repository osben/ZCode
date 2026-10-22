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
  /**
   * Null only when neither a live projection nor a catalog exists for the agent: the placeholder "available after
   * the first message" renders. The live projection wins once it belongs to this agent; the catalog stands in before.
   */
  options: ExternalAgentComposerOptions | null;
  /**
   * Draft (no session yet): a choice updates the draft's state and is sent with the first submission (S6 readiness).
   * Session: a choice is dispatched as setExternalAgentConfigOption and is enabled only for this agent's session.
   */
  draft: boolean;
  enabled: boolean;
}

/** Choices made in the draft before its first submission, by config id (UI-local, never persisted). */
export type ExternalAgentDraftChoices = Readonly<Record<string, string>>;

/**
 * Composer state for the draft's model. Null when the model is not an ACP agent (the ZCode mode switch renders).
 * `catalog` is the agent's last offered options (undefined while loading). The draft's choices overlay the options
 * of a draft, so the selects show what the first submission will send.
 */
export function resolveExternalAgentComposerState(params: {
  draftProviderId: string | null | undefined;
  sessionId: string | null | undefined;
  sessionProviderId: string | null | undefined;
  projection: ExternalAgentConfigState | null | undefined;
  catalog?: readonly ExternalAgentConfigOption[] | null;
  draftChoices?: ExternalAgentDraftChoices;
}): ExternalAgentComposerState | null {
  const agentId = resolveExternalAgentId(params.draftProviderId);
  if (!agentId) return null;
  const draft = !params.sessionId;
  const live = params.projection?.agentId === agentId ? params.projection.options : null;
  const offered = live ?? params.catalog ?? null;
  const overlaid = offered
    ? draft && params.draftChoices
      ? overlayDraftChoices(offered, params.draftChoices)
      : offered
    : null;
  return {
    agentId,
    options: overlaid ? selectExternalAgentComposerOptions(overlaid) : null,
    draft,
    enabled: draft
      ? overlaid !== null
      : resolveExternalAgentId(params.sessionProviderId) === agentId,
  };
}

/** The offered options with a draft's choices as their current values (only values the option offers). */
export function overlayDraftChoices(
  options: readonly ExternalAgentConfigOption[],
  choices: ExternalAgentDraftChoices,
): ExternalAgentConfigOption[] {
  return options.map((option) => {
    const chosen = choices[option.id];
    if (chosen === undefined || !option.options.some((value) => value.value === chosen)) {
      return option;
    }
    return { ...option, currentValue: chosen };
  });
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
