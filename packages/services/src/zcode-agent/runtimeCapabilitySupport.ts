import {
  incognitoCapabilityGateError,
  INCOGNITO_UNSUPPORTED_ERROR,
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesSchema,
  type ZCodeRuntimeCapabilities,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

type CapabilityClient = Pick<ZCodeProtocolClient, "request">;

const capabilityReads = new WeakMap<object, Promise<ZCodeRuntimeCapabilities>>();

/** One capability read per CLI client; a failed read is retried on the next check. */
function readRuntimeCapabilities(client: CapabilityClient): Promise<ZCodeRuntimeCapabilities> {
  const cached = capabilityReads.get(client);
  if (cached) return cached;
  const read = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .catch((cause: unknown) => {
      capabilityReads.delete(client);
      throw cause;
    });
  capabilityReads.set(client, read);
  return read;
}

/**
 * A Host update does not mean the remote CLI is updated, and older CLIs strip unknown fields, so
 * confirm the execution endpoint advertises `capability` before sending a field that depends on it.
 */
async function ensureRuntimeCapability(
  client: CapabilityClient,
  capability: keyof ZCodeRuntimeCapabilities,
  errorCode: string,
): Promise<void> {
  let capabilities: ZCodeRuntimeCapabilities;
  try {
    capabilities = await readRuntimeCapabilities(client);
  } catch (cause) {
    throw new Error(errorCode, { cause });
  }
  if (capabilities[capability] !== true) throw new Error(errorCode);
}

export function ensureIndependentPlanSupport(client: CapabilityClient): Promise<void> {
  return ensureRuntimeCapability(
    client,
    "independentPlanState",
    "proto.independentPlanUnsupported",
  );
}

/** Gen UI state must not fall back to being spliced into the user's text; when unsupported, keep the draft and refuse to send. */
export function ensureGenUiContextSupport(client: CapabilityClient): Promise<void> {
  return ensureRuntimeCapability(client, "genUiContext", "proto.genUiContextUnsupported");
}

/**
 * Older remote CLIs use strict subscribe and reject the history-first field, so the field is
 * forwarded only after the endpoint advertises `historyFirst`. A failed read answers false.
 */
export async function supportsHistoryFirst(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).historyFirst === true;
  } catch {
    return false;
  }
}

/**
 * specs/provider-registry-refresh-barrier.md: a remote CLI can predate provider/refreshRegistry, so the
 * V4 command barrier refreshes only when the endpoint advertises it. A failed read answers false.
 */
export async function supportsProviderRegistryRefresh(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).providerRegistryRefresh === true;
  } catch {
    return false;
  }
}

/**
 * Fork: the agent runs `acp:<agentId>` selections (specs/fork-agent-runtime-selection.md rule 7). A failed read
 * answers false.
 */
export async function supportsExternalAgentTurns(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).externalAgentTurns === true;
  } catch {
    return false;
  }
}

/** specs/incognito-session.md: an incognito create must never run as a normal session. */
export async function ensureIncognitoSupport(client: CapabilityClient): Promise<void> {
  let capabilities: ZCodeRuntimeCapabilities;
  try {
    capabilities = await readRuntimeCapabilities(client);
  } catch (cause) {
    // A failed capability read keeps the bare code: the endpoint's flags are unknown.
    throw new Error(INCOGNITO_UNSUPPORTED_ERROR, { cause });
  }
  const gateError = incognitoCapabilityGateError(capabilities);
  if (gateError) throw new Error(gateError);
}

/** Older CLIs strip unknown createSession fields; never let a reservation start a runtime. */
export function ensureDurableFirstSubmissionSupport(client: CapabilityClient): Promise<void> {
  return ensureRuntimeCapability(
    client,
    "durableFirstSubmission",
    "proto.durableFirstSubmissionUnsupported",
  );
}

/** The CLI advertises plugin discovery UI support; a failed read answers false. */
export async function supportsPluginDiscoveryUi(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).pluginDiscoveryUi === true;
  } catch {
    return false;
  }
}

/**
 * plugins/overview includeExtensionSummary: older CLIs use a strict parameter schema, so one extra
 * key rejects the whole request. The field is sent only when the endpoint advertises it.
 */
export async function supportsPluginExtensionSummary(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).pluginExtensionSummary === true;
  } catch {
    return false;
  }
}

/**
 * Older CLIs use a strict metadata schema that does not know ownerKey. Without support only the new
 * field is dropped and the send continues.
 */
export async function supportsHighspeedCardOwner(client: CapabilityClient): Promise<boolean> {
  try {
    return (await readRuntimeCapabilities(client)).highspeedCardOwner === true;
  } catch {
    return false;
  }
}
