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
