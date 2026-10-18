import {
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

/** specs/incognito-session.md: an incognito create must never run as a normal session. */
export function ensureIncognitoSupport(client: CapabilityClient): Promise<void> {
  return ensureRuntimeCapability(client, "incognitoSession", INCOGNITO_UNSUPPORTED_ERROR);
}
