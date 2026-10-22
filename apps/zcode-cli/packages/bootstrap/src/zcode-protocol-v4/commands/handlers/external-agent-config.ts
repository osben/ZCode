// External agent config command group: setExternalAgentConfigOption (specs/acp-agent-runtime.md "S6:
// agent configuration options"). Pure handler (host, envelope) -> CommandResult|undefined.
//
// The session owns the user's chosen values. The handler stores the choice, updates the display copy
// and appends external_agent_config_updated; it never touches the agent process. The driver applies
// the choice before the next prompt, so a running turn is not interrupted.
import {
  SessionEventType,
  createSessionEvent,
  externalAgentConfigOffers,
  type ExternalAgentConfigUpdatedPayload,
  type SessionId,
} from "@zcode/contracts";
import { ACP_PROVIDER_ID_PREFIX } from "@zcode/provider";
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { requireRecord } from "../record-access.js";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";
import type { V4CommandCoreHost } from "../types.js";

export type ExternalAgentConfigRejection =
  | "config.notAvailable"
  | "config.invalid"
  | "config.notExternalAgent";

/** A refused choice; the gateway turns `reasonCode` into a failed ACK. */
export class V4ExternalAgentConfigError extends Error {
  constructor(
    readonly reasonCode: ExternalAgentConfigRejection,
    message: string,
  ) {
    super(message);
    this.name = "V4ExternalAgentConfigError";
  }
}

async function setExternalAgentConfigOption(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentConfigOption"];
  if (payload.sessionId !== envelope.sessionId) {
    throw new V4ExternalAgentConfigError(
      "config.invalid",
      "The option belongs to a different session than the command.",
    );
  }
  const record = requireRecord(host, envelope.sessionId);
  const store = host.externalAgentConfig;
  if (!store) throw new V4CapabilityUnsupportedError("externalAgentConfig", payload.sessionId);

  const providerId = record.app.runtime.getSessionModelSelection()?.providerId;
  if (!providerId?.startsWith(ACP_PROVIDER_ID_PREFIX)) {
    throw new V4ExternalAgentConfigError(
      "config.notExternalAgent",
      "Agent options apply only when the session model is an ACP agent.",
    );
  }
  const agentId = providerId.slice(ACP_PROVIDER_ID_PREFIX.length);
  const config = await store.readConfig(payload.sessionId);
  // Stored options of another agent describe a process configuration that no longer applies.
  if (config.agentId !== undefined && config.agentId !== agentId) {
    throw new V4ExternalAgentConfigError(
      "config.notAvailable",
      "Agent options are available after the first message.",
    );
  }
  // The live snapshot of the session wins. Before the first turn the agent's catalog (S6 readiness) offers the
  // options, and the choice is kept as a pending choice that the first turn applies.
  const offered = config.offered ?? (await store.readCatalog(agentId));
  if (offered === undefined) {
    throw new V4ExternalAgentConfigError(
      "config.notAvailable",
      "Agent options are available after the first message.",
    );
  }
  const option = offered.find((item) => item.id === payload.configId);
  if (option === undefined || !externalAgentConfigOffers(option, payload.value)) {
    throw new V4ExternalAgentConfigError(
      "config.invalid",
      "The agent does not offer this option value.",
    );
  }
  // An explicit choice of the shown value still pins it unless it is already the chosen value: the
  // display copy may show an agent-initiated value that the next reconcile would otherwise revert.
  if (config.choices[payload.configId] === payload.value && option.currentValue === payload.value) {
    throw new V4CommandNoopError("config.unchanged");
  }

  await store.writeChoice(payload.sessionId, agentId, payload.configId, payload.value);
  const options = offered.map((item) =>
    item.id === payload.configId ? { ...item, currentValue: payload.value } : item,
  );
  // Only a binding has a stored copy; a pending session has none until its first turn writes one.
  await store.writeOffered(payload.sessionId, options);
  const event: ExternalAgentConfigUpdatedPayload = { agentId, options };
  await record.app.runtime.appendEvent(
    createSessionEvent(
      SessionEventType.ExternalAgentConfigUpdated,
      payload.sessionId as SessionId,
      event,
      { traceId: record.traceContext.traceId },
    ),
    record.traceContext,
  );
  return undefined;
}

export const externalAgentConfigHandlers = { setExternalAgentConfigOption };
