import { z } from "zod";

/**
 * Incognito session capabilities (specs/incognito-session.md). Each key is a capability that an
 * incognito session can opt back into; `true` means the capability is included in the session.
 * Everything not listed here is core and never toggleable.
 */
const incognitoCapabilitiesSchema = z
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
    // Profile v2: identity, harness and environment prompt text and the workflow/automation tool set
    // were core in v1 (see "Prompt toggles (v2)" in specs/incognito-session.md).
    identity: z.boolean(),
    harness: z.boolean(),
    environment: z.boolean(),
    automationTools: z.boolean(),
  })
  .strict();

export type IncognitoCapabilities = z.infer<typeof incognitoCapabilitiesSchema>;
export type IncognitoCapabilityKey = keyof IncognitoCapabilities;
export const INCOGNITO_CAPABILITY_KEYS = incognitoCapabilitiesSchema.keyof().options;

export const INCOGNITO_PROFILE_VERSION = 2 as const;
/** v2 additions; a v1 session always ran with them included, so the upgrade sets them to true. */
const INCOGNITO_V2_ADDED_KEYS = ["identity", "harness", "environment", "automationTools"] as const;

/** Error thrown by the renderer transport and the Host when a hop cannot honor `incognito`. */
export const INCOGNITO_UNSUPPORTED_ERROR = "proto.incognitoUnsupported" as const;

/**
 * The resolved, explicit value of every capability for one session, frozen at creation and
 * persisted in `session.fork_incognito`. Never a diff against Settings defaults.
 */
export const incognitoProfileSchema = incognitoCapabilitiesSchema.extend({
  version: z.literal(INCOGNITO_PROFILE_VERSION),
});

export type IncognitoProfile = z.infer<typeof incognitoProfileSchema>;

/** Strict version-1 shape, accepted only by the stored-profile reader (never written). */
const incognitoProfileV1Schema = incognitoCapabilitiesSchema
  .omit(
    Object.fromEntries(INCOGNITO_V2_ADDED_KEYS.map((key) => [key, true])) as Record<
      (typeof INCOGNITO_V2_ADDED_KEYS)[number],
      true
    >,
  )
  .extend({ version: z.literal(1) })
  .strict();

const allCapabilitiesOff = Object.fromEntries(
  INCOGNITO_CAPABILITY_KEYS.map((key) => [key, false]),
) as IncognitoCapabilities;

/** The most restrictive profile; also the reading of any stored profile this build cannot parse. */
export const INCOGNITO_LOCKDOWN_PROFILE: IncognitoProfile = Object.freeze({
  version: INCOGNITO_PROFILE_VERSION,
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

export const incognitoDefaultsPatchSchema = incognitoCapabilitiesSchema;

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
  return incognitoProfileSchema.parse({ version: INCOGNITO_PROFILE_VERSION, ...capabilities });
}

/**
 * Decode `session.fork_incognito`. `null`/`undefined` is a normal session. A stored v1 profile is
 * upgraded in memory to v2 with the v2 toggles included (v1 sessions always ran with them). A value
 * this build cannot parse (damaged JSON, unknown version or shape) fails closed to the lockdown
 * profile so an incognito session never runs as a normal one.
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
  const current = incognitoProfileSchema.safeParse(raw);
  if (current.success) return current.data;
  const v1 = incognitoProfileV1Schema.safeParse(raw);
  if (v1.success) {
    const { version: _version, ...capabilities } = v1.data;
    return buildIncognitoProfile({
      ...capabilities,
      identity: true,
      harness: true,
      environment: true,
      automationTools: true,
    });
  }
  return INCOGNITO_LOCKDOWN_PROFILE;
}

/**
 * Deep-equal on the normalized profile shape (version + every capability). Reuse decisions compare
 * a requested profile against the stored one; `undefined` (normal session) never equals a profile,
 * so an absent request for an incognito session is a mismatch too.
 */
export function incognitoProfilesEqual(
  a: IncognitoProfile | undefined,
  b: IncognitoProfile | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.version === b.version && INCOGNITO_CAPABILITY_KEYS.every((key) => a[key] === b[key]);
}
