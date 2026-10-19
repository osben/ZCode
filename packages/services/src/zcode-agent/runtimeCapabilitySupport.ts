import {
  INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
  INCOGNITO_SESSION_UNSUPPORTED_ERROR,
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
  readFailureCode: string = errorCode,
): Promise<void> {
  let capabilities: ZCodeRuntimeCapabilities;
  try {
    capabilities = await readRuntimeCapabilities(client);
  } catch (cause) {
    throw new Error(readFailureCode, { cause });
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
export async function ensureIncognitoSupport(client: CapabilityClient): Promise<void> {
  // Both flags are required. incognitoSession is checked first: a CLI without it has no incognito
  // support at all. A CLI with it but without incognitoPromptToggles is a stale build that cannot
  // parse the thirteen-key profile. A failed capability read keeps the bare code.
  await ensureRuntimeCapability(
    client,
    "incognitoSession",
    INCOGNITO_SESSION_UNSUPPORTED_ERROR,
    INCOGNITO_UNSUPPORTED_ERROR,
  );
  await ensureRuntimeCapability(
    client,
    "incognitoPromptToggles",
    INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
    INCOGNITO_UNSUPPORTED_ERROR,
  );
}
