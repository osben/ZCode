import { z } from "zod";

/**
 * Incognito session capabilities (specs/incognito-session.md). Each key is a capability that an
 * incognito session can opt back into; `true` means the capability is included in the session.
 * Everything not listed here is core and never toggleable.
 *
 * The profile is flat and strict with no version field: an object with an unknown or missing key
 * is rejected by every reader that does not know this exact key set (see "Compatibility").
 */
export const incognitoProfileSchema = z
  .object({
    projectInstructions: z.boolean(),
    skills: z.boolean(),
    hooks: z.boolean(),
    plugins: z.boolean(),
    mcp: z.boolean(),
    customAgents: z.boolean(),
    memory: z.boolean(),
    outputStyle: z.boolean(),
    systemPromptOverrides: z.boolean(),
    // Identity, harness and environment prompt text and the workflow/automation tool set were core
    // before these toggles existed (specs/incognito-session.md, "Prompt toggles").
    identity: z.boolean(),
    harness: z.boolean(),
    environment: z.boolean(),
    automationTools: z.boolean(),
  })
  .strict();

/**
 * The resolved, explicit value of every capability for one session, frozen at creation and
 * persisted in `session.fork_incognito`. Never a diff against Settings defaults.
 */
export type IncognitoProfile = z.infer<typeof incognitoProfileSchema>;
export type IncognitoCapabilities = IncognitoProfile;
export type IncognitoCapabilityKey = keyof IncognitoCapabilities;
export const INCOGNITO_CAPABILITY_KEYS = incognitoProfileSchema.keyof().options;

/** Error thrown by the renderer transport and the Host when a hop cannot honor `incognito`. */
export const INCOGNITO_UNSUPPORTED_ERROR = "proto.incognitoUnsupported" as const;
/** The CLI or Host does not advertise `incognitoSession` (agent without incognito support). */
export const INCOGNITO_SESSION_UNSUPPORTED_ERROR =
  "proto.incognitoUnsupported.sessionCapability" as const;
/**
 * `incognitoSession` is advertised but `incognitoPromptToggles` is not: a stale agent build that
 * cannot parse the thirteen-key profile.
 */
export const INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR =
  "proto.incognitoUnsupported.promptToggles" as const;

/**
 * The runtime capabilities an incognito create depends on. Every hop (renderer transport, Host
 * service) checks them through `incognitoCapabilityGateError`, so the order lives in one place:
 * `incognitoSession` first (no incognito support at all), then `incognitoPromptToggles` (a stale
 * build that cannot parse the thirteen-key profile).
 */
export function incognitoCapabilityGateError(capabilities: {
  readonly incognitoSession?: boolean;
  readonly incognitoPromptToggles?: boolean;
}): string | null {
  if (capabilities.incognitoSession !== true) return INCOGNITO_SESSION_UNSUPPORTED_ERROR;
  if (capabilities.incognitoPromptToggles !== true) {
    return INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR;
  }
  return null;
}

const allCapabilitiesOff = Object.fromEntries(
  INCOGNITO_CAPABILITY_KEYS.map((key) => [key, false]),
) as IncognitoCapabilities;

/** The most restrictive profile; also the reading of any stored profile this build cannot parse. */
export const INCOGNITO_LOCKDOWN_PROFILE: IncognitoProfile = Object.freeze({
  ...allCapabilitiesOff,
});

/**
 * Settings defaults (`incognitoDefaults`, fork sidecar). Reads tolerate a partial or damaged
 * object (a missing capability is off); writes must send every capability, because the sidecar
 * merges top-level keys only and a partial object would silently drop the others.
 */
export const incognitoDefaultsStoredSchema = z.object(
  Object.fromEntries(
    INCOGNITO_CAPABILITY_KEYS.map((key) => [key, z.boolean().optional().catch(undefined)]),
  ) as Record<IncognitoCapabilityKey, z.ZodCatch<z.ZodOptional<z.ZodBoolean>>>,
);

export const incognitoDefaultsPatchSchema = incognitoProfileSchema;

export type IncognitoDefaults = Partial<IncognitoCapabilities>;

/** Effective Settings defaults: a capability the user never set is off. */
export function resolveIncognitoDefaults(
  stored: IncognitoDefaults | undefined,
): IncognitoCapabilities {
  const resolved = { ...allCapabilitiesOff };
  for (const key of INCOGNITO_CAPABILITY_KEYS) {
    if (stored?.[key] === true) resolved[key] = true;
  }
  return resolved;
}

/** True when the session is incognito and `capability` is not opted back in. */
export function incognitoExcludes(
  profile: IncognitoProfile | undefined,
  capability: IncognitoCapabilityKey,
): boolean {
  return profile !== undefined && !profile[capability];
}

export function buildIncognitoProfile(capabilities: IncognitoCapabilities): IncognitoProfile {
  return incognitoProfileSchema.parse(capabilities);
}

/**
 * Decode `session.fork_incognito`. `null`/`undefined` is a normal session. Any stored value that is
 * not exactly the current flat profile (damaged JSON, unknown or missing key, a `version` key)
 * fails closed to the lockdown profile so an incognito session never runs as a normal one. Rows
 * written with the pre-toggle nine-key shape read as lockdown too; there is no upgrade-on-read.
 */
export function parseStoredIncognitoProfile(
  stored: string | null | undefined,
): IncognitoProfile | undefined {
  if (stored === null || stored === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return INCOGNITO_LOCKDOWN_PROFILE;
  }
  const parsed = incognitoProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : INCOGNITO_LOCKDOWN_PROFILE;
}

/**
 * Deep-equal on the normalized profile shape (every capability). Reuse decisions compare a
 * requested profile against the stored one; `undefined` (normal session) never equals a profile,
 * so an absent request for an incognito session is a mismatch too.
 */
export function incognitoProfilesEqual(
  a: IncognitoProfile | undefined,
  b: IncognitoProfile | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return INCOGNITO_CAPABILITY_KEYS.every((key) => a[key] === b[key]);
}
