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
  })
  .strict();

export type IncognitoCapabilities = z.infer<typeof incognitoCapabilitiesSchema>;
export type IncognitoCapabilityKey = keyof IncognitoCapabilities;
export const INCOGNITO_CAPABILITY_KEYS = incognitoCapabilitiesSchema.keyof().options;

export const INCOGNITO_PROFILE_VERSION = 1 as const;

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

export function buildIncognitoProfile(capabilities: IncognitoCapabilities): IncognitoProfile {
  return incognitoProfileSchema.parse({ version: INCOGNITO_PROFILE_VERSION, ...capabilities });
}

/**
 * Decode `session.fork_incognito`. `null`/`undefined` is a normal session. A value this build
 * cannot parse (damaged JSON, a newer profile version) fails closed to the lockdown profile so an
 * incognito session never runs as a normal one.
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
