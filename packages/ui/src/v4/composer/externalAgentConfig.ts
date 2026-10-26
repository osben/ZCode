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

/**
 * The model option without the values the user hid in Settings (specs/acp-agent-runtime.md "Settings: models and
 * Advanced"). The current value is never hidden, so the select always shows it.
 */
export function hideExternalAgentModels(
  selected: ExternalAgentComposerOptions,
  hiddenModels: readonly string[] | undefined,
): ExternalAgentComposerOptions {
  const model = selected.model;
  if (!model || !hiddenModels?.length) return selected;
  const hidden = new Set(hiddenModels);
  const options = model.options.filter(
    (value) => value.value === model.currentValue || !hidden.has(value.value),
  );
  return options.length === model.options.length
    ? selected
    : { ...selected, model: { ...model, options } };
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
  /** Model values hidden in Settings; they are left out of the model select, except its current value. */
  hiddenModels?: readonly string[];
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
    options: overlaid
      ? hideExternalAgentModels(selectExternalAgentComposerOptions(overlaid), params.hiddenModels)
      : null,
    draft,
    enabled: draft
      ? overlaid !== null
      : resolveExternalAgentId(params.sessionProviderId) === agentId,
  };
}

/**
 * Pre-submission choices of every draft, keyed by the draft session that the first submission uses (S6 readiness).
 * A draft's choices are only ever read and sent for that draft, so a switched task never receives another draft's
 * choices. They are removed once sent, because the session holds them from then on.
 */
export type DraftExternalAgentChoices = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
>;

export function draftExternalAgentChoicesOf(
  state: DraftExternalAgentChoices,
  draftSessionId: string,
  agentId: string,
): Readonly<Record<string, string>> | undefined {
  return state[draftSessionId]?.[agentId];
}

export function setDraftExternalAgentChoice(
  state: DraftExternalAgentChoices,
  draftSessionId: string,
  agentId: string,
  configId: string,
  value: string,
): DraftExternalAgentChoices {
  const draft = state[draftSessionId] ?? {};
  return {
    ...state,
    [draftSessionId]: { ...draft, [agentId]: { ...draft[agentId], [configId]: value } },
  };
}

/** The state without one draft's choices (they were sent with its first submission). */
export function takeDraftExternalAgentChoices(
  state: DraftExternalAgentChoices,
  draftSessionId: string,
): DraftExternalAgentChoices {
  if (!(draftSessionId in state)) return state;
  const next = { ...state };
  delete next[draftSessionId];
  return next;
}

/**
 * Sends one draft's choices to the session that receives its first submission. The choices are read from the draft
 * they belong to (`draftSessionId`); the target can be another session (a worktree draft creates its own). Returns
 * the refusal message of the first choice the session did not accept (nothing else is sent after it), or null. The
 * caller clears the draft only when `sent` is true, so a refused draft keeps its choices.
 */
export async function sendDraftExternalAgentChoices(params: {
  state: DraftExternalAgentChoices;
  draftSessionId: string;
  agentId: string;
  targetSessionId: string;
  send(targetSessionId: string, configId: string, value: string): Promise<string | null>;
}): Promise<{ sent: boolean; refusedMessageId: string | null }> {
  const choices = draftExternalAgentChoicesOf(params.state, params.draftSessionId, params.agentId);
  if (!choices) return { sent: false, refusedMessageId: null };
  for (const [configId, value] of Object.entries(choices)) {
    const refusedMessageId = await params.send(params.targetSessionId, configId, value);
    if (refusedMessageId !== null) return { sent: false, refusedMessageId };
  }
  return { sent: true, refusedMessageId: null };
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

/**
 * One draft send's share of its draft choices. Taken synchronously when the send starts, so no other apply can read
 * the same choices (`begun`), and the pane restores it when it was not delivered (`delivered` stays false).
 */
export interface DraftExternalAgentClaim {
  readonly draftKey: string;
  readonly agentId: string;
  readonly choices: Readonly<Record<string, string>>;
  begun: boolean;
  delivered: boolean;
}

/** The state without one agent's choices in a draft; the choices of the draft's other agents stay. */
function withoutAgentChoices(
  state: DraftExternalAgentChoices,
  draftKey: string,
  agentId: string,
): DraftExternalAgentChoices {
  const { [agentId]: _claimed, ...otherAgents } = state[draftKey] ?? {};
  if (Object.keys(otherAgents).length === 0) return takeDraftExternalAgentChoices(state, draftKey);
  return { ...state, [draftKey]: otherAgents };
}

/**
 * Takes the draft's choices for one send, for the claiming agent only. Only a draft send (no bound session) claims: a bound task never receives a
 * draft's choices, whatever agent it runs.
 */
export function claimDraftExternalAgentChoices(params: {
  state: DraftExternalAgentChoices;
  draftKey: string;
  agentId: string;
  sessionId: string | null;
}): { state: DraftExternalAgentChoices; claim: DraftExternalAgentClaim | null } {
  if (params.sessionId !== null) return { state: params.state, claim: null };
  const choices = draftExternalAgentChoicesOf(params.state, params.draftKey, params.agentId);
  if (!choices || Object.keys(choices).length === 0) return { state: params.state, claim: null };
  return {
    state: withoutAgentChoices(params.state, params.draftKey, params.agentId),
    claim: {
      draftKey: params.draftKey,
      agentId: params.agentId,
      choices: { ...choices },
      begun: false,
      delivered: false,
    },
  };
}

/**
 * Puts a claim back after a send that did not deliver it. A choice the user made after the claim wins over the
 * restored value of the same config id.
 */
export function restoreDraftExternalAgentChoices(
  state: DraftExternalAgentChoices,
  claim: DraftExternalAgentClaim,
): DraftExternalAgentChoices {
  const current = draftExternalAgentChoicesOf(state, claim.draftKey, claim.agentId) ?? {};
  return {
    ...state,
    [claim.draftKey]: {
      ...state[claim.draftKey],
      [claim.agentId]: { ...claim.choices, ...current },
    },
  };
}

/**
 * Sends a claimed draft's choices once. A second call on the same claim does nothing; a refusal leaves the claim
 * undelivered so the caller restores it.
 */
export async function sendClaimedDraftExternalAgentChoices(params: {
  claim: DraftExternalAgentClaim | null;
  targetSessionId: string;
  send(targetSessionId: string, configId: string, value: string): Promise<string | null>;
}): Promise<{ refusedMessageId: string | null }> {
  const claim = params.claim;
  if (!claim || claim.begun) return { refusedMessageId: null };
  claim.begun = true;
  const outcome = await sendDraftExternalAgentChoices({
    state: { [claim.draftKey]: { [claim.agentId]: claim.choices } },
    draftSessionId: claim.draftKey,
    agentId: claim.agentId,
    targetSessionId: params.targetSessionId,
    send: params.send,
  });
  claim.delivered = outcome.refusedMessageId === null;
  return { refusedMessageId: outcome.refusedMessageId };
}
