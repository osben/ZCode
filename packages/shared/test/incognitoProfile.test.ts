import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INCOGNITO_CAPABILITY_KEYS,
  INCOGNITO_LOCKDOWN_PROFILE,
  INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
  INCOGNITO_SESSION_UNSUPPORTED_ERROR,
  INCOGNITO_UNSUPPORTED_ERROR,
  buildIncognitoProfile,
  incognitoExcludes,
  incognitoProfileSchema,
  incognitoProfilesEqual,
  parseStoredIncognitoProfile,
  resolveIncognitoDefaults,
} from "../src/incognito-profile.js";
import { forkAppSettingsPatchSchema, forkAppSettingsSchema } from "../src/forkAppSettings.js";
import {
  zcodeRuntimeCapabilitiesSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
} from "../src/zcode-protocol/index.js";
import { hostCapabilitiesSchema, parseCommandEnvelope } from "../src/zcode-protocol-v4/index.js";

const allOff = { ...INCOGNITO_LOCKDOWN_PROFILE };
const PROMPT_TOGGLE_KEYS = ["identity", "harness", "environment", "automationTools"] as const;
const PRE_TOGGLE_KEYS = INCOGNITO_CAPABILITY_KEYS.filter(
  (key) => !(PROMPT_TOGGLE_KEYS as readonly string[]).includes(key),
);

describe("incognito profile", () => {
  it("is a flat strict profile with the thirteen capability keys and no version field", () => {
    expect(INCOGNITO_CAPABILITY_KEYS).toHaveLength(13);
    expect(INCOGNITO_CAPABILITY_KEYS).not.toContain("version");
    expect(Object.keys(INCOGNITO_LOCKDOWN_PROFILE).sort()).toEqual(
      [...INCOGNITO_CAPABILITY_KEYS].sort(),
    );
    expect(incognitoProfileSchema.safeParse({ ...allOff, version: 2 }).success).toBe(false);
    expect(incognitoProfileSchema.safeParse({ ...allOff, extra: true }).success).toBe(false);
    expect(incognitoProfileSchema.safeParse({ skills: true }).success).toBe(false);
  });

  it("lockdown profile has every capability off", () => {
    for (const key of INCOGNITO_CAPABILITY_KEYS) {
      expect(INCOGNITO_LOCKDOWN_PROFILE[key]).toBe(false);
    }
    expect(incognitoProfileSchema.parse(INCOGNITO_LOCKDOWN_PROFILE)).toEqual(
      INCOGNITO_LOCKDOWN_PROFILE,
    );
  });

  it("resolves Settings defaults to every capability off and keeps explicit values", () => {
    expect(resolveIncognitoDefaults(undefined)).toEqual(allOff);
    expect(resolveIncognitoDefaults({ skills: true, memory: false })).toMatchObject({
      skills: true,
      memory: false,
      hooks: false,
    });
  });

  it("compares profiles deeply and never treats absent as equal to a profile", () => {
    expect(incognitoProfilesEqual(INCOGNITO_LOCKDOWN_PROFILE, INCOGNITO_LOCKDOWN_PROFILE)).toBe(
      true,
    );
    expect(incognitoProfilesEqual(INCOGNITO_LOCKDOWN_PROFILE, { ...allOff, skills: true })).toBe(
      false,
    );
    expect(incognitoProfilesEqual(INCOGNITO_LOCKDOWN_PROFILE, undefined)).toBe(false);
    expect(incognitoProfilesEqual(undefined, undefined)).toBe(true);
  });

  it("builds a resolved profile from capabilities, never a diff", () => {
    const profile = buildIncognitoProfile({ ...resolveIncognitoDefaults(undefined), mcp: true });
    expect(incognitoProfileSchema.parse(profile)).toEqual({
      ...INCOGNITO_LOCKDOWN_PROFILE,
      mcp: true,
    });
  });

  it("excludes a capability only for an incognito session that did not opt back in", () => {
    expect(incognitoExcludes(undefined, "skills")).toBe(false);
    expect(incognitoExcludes(INCOGNITO_LOCKDOWN_PROFILE, "skills")).toBe(true);
    expect(incognitoExcludes({ ...INCOGNITO_LOCKDOWN_PROFILE, skills: true }, "skills")).toBe(
      false,
    );
  });

  it("reads any stored value that is not the exact flat profile as lockdown, never as a normal session", () => {
    expect(parseStoredIncognitoProfile("{not json")).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    // A version-era row (the version key is unknown to the flat schema) is not a current profile.
    expect(
      parseStoredIncognitoProfile(JSON.stringify({ ...INCOGNITO_LOCKDOWN_PROFILE, version: 2 })),
    ).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    expect(parseStoredIncognitoProfile(JSON.stringify({ skills: true }))).toEqual(
      INCOGNITO_LOCKDOWN_PROFILE,
    );
    expect(parseStoredIncognitoProfile(JSON.stringify(allOff))).toEqual(allOff);
    expect(parseStoredIncognitoProfile(null)).toBeUndefined();
  });

  it("reads a pre-toggle nine-key row as lockdown, with no upgrade-on-read", () => {
    const preToggleStored = JSON.stringify({
      version: 1,
      projectInstructions: false,
      skills: true,
      hooks: false,
      plugins: false,
      mcp: false,
      customAgents: false,
      memory: false,
      outputStyle: false,
      systemPromptOverrides: false,
    });
    expect(parseStoredIncognitoProfile(preToggleStored)).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    const withoutVersion = Object.fromEntries(
      Object.entries(JSON.parse(preToggleStored) as Record<string, unknown>).filter(
        ([key]) => key !== "version",
      ),
    );
    // Missing the four toggle keys: not a current profile either.
    expect(parseStoredIncognitoProfile(JSON.stringify(withoutVersion))).toEqual(
      INCOGNITO_LOCKDOWN_PROFILE,
    );
  });

  it("pins the pre-change readers: strict shapes reject a thirteen-key row with a version key or without one", () => {
    // Reproduces the shape the nine-key reader used (`.strict()` capabilities, then `.extend({ version })`).
    // zod 4 keeps `.strict()` through `.extend()`, so unknown keys and a missing version both fail.
    const preToggleReader = z
      .object(Object.fromEntries(PRE_TOGGLE_KEYS.map((key) => [key, z.boolean()])))
      .strict()
      .extend({ version: z.literal(1) });
    expect(preToggleReader.safeParse(INCOGNITO_LOCKDOWN_PROFILE).success).toBe(false);
    expect(preToggleReader.safeParse({ ...INCOGNITO_LOCKDOWN_PROFILE, version: 1 }).success).toBe(
      false,
    );
    // The toggle-era reader required `version: 2`, so a versionless row fails it too.
    const toggleEraReader = z
      .object(Object.fromEntries(INCOGNITO_CAPABILITY_KEYS.map((key) => [key, z.boolean()])))
      .strict()
      .extend({ version: z.literal(2) });
    expect(toggleEraReader.safeParse(INCOGNITO_LOCKDOWN_PROFILE).success).toBe(false);
    expect(toggleEraReader.safeParse({ ...INCOGNITO_LOCKDOWN_PROFILE, version: 2 }).success).toBe(
      true,
    );
  });
});

describe("incognitoDefaults fork setting", () => {
  it("stores only explicitly set capabilities and drops damaged values", () => {
    expect(forkAppSettingsSchema.parse({}).incognitoDefaults).toBeUndefined();
    expect(
      forkAppSettingsSchema.parse({ incognitoDefaults: { skills: true, hooks: "yes" } })
        .incognitoDefaults,
    ).toEqual({ skills: true });
  });

  it("patch requires every capability, so a write can never silently drop the others", () => {
    expect(
      forkAppSettingsPatchSchema.safeParse({ incognitoDefaults: { ...allOff, mcp: true } }).success,
    ).toBe(true);
    expect(forkAppSettingsPatchSchema.safeParse({ incognitoDefaults: { mcp: true } }).success).toBe(
      false,
    );
    expect(
      forkAppSettingsPatchSchema.safeParse({ incognitoDefaults: { ...allOff, version: 2 } })
        .success,
    ).toBe(false);
  });
});

describe("incognito protocol fields", () => {
  const workspace = { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" };
  const profile = { ...INCOGNITO_LOCKDOWN_PROFILE, skills: true };

  function createEnvelope(payload: Record<string, unknown>) {
    return parseCommandEnvelope({
      commandId: "cmd-incognito",
      clientId: "client-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "ws-1", ...payload },
      issuedAt: 1000,
    });
  }

  it("v4 createSession carries a strict flat profile and rejects the versioned shape", () => {
    const result = createEnvelope({ incognito: profile });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.envelope.payload as { incognito?: unknown }).incognito).toEqual(profile);
    }
    expect(createEnvelope({ incognito: { ...profile, version: 2 } }).ok).toBe(false);
    expect(createEnvelope({ incognito: { version: 1, skills: true } }).ok).toBe(false);
    expect(createEnvelope({}).ok).toBe(true);
  });

  it("v4 worktree preparation cannot carry incognito; the activation create can", () => {
    // The prepare step reserves the row without a profile, so accepting both would persist a
    // normal session the caller believes is incognito (specs/incognito-session.md, Protocol).
    expect(
      createEnvelope({
        worktreePreparation: { branchName: "b", targetPath: "/wt/b" },
        incognito: profile,
      }).ok,
    ).toBe(false);
    expect(
      createEnvelope({
        preparedSessionId: "session-prepared",
        executionWorktree: { path: "/wt/b", branchName: "b" },
        incognito: profile,
      }).ok,
    ).toBe(true);
  });

  it("legacy session/create carries the profile; resume never does (it reads the session row)", () => {
    expect(
      zcodeSessionCreateParamsSchema.parse({ workspace, incognito: profile }).incognito,
    ).toEqual(profile);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({ workspace, incognito: { version: 1 } }),
    ).toThrow();
    expect(() =>
      zcodeSessionResumeParamsSchema.parse({ sessionId: "sess_1", incognito: profile }),
    ).toThrow();
  });

  it("CLI and Host advertise incognito support as optional capabilities", () => {
    expect(zcodeRuntimeCapabilitiesSchema.parse({ incognitoSession: true }).incognitoSession).toBe(
      true,
    );
    expect(zcodeRuntimeCapabilitiesSchema.parse({}).incognitoSession).toBeUndefined();
    // The shape gate: a CLI without incognitoPromptToggles cannot persist or enforce the four prompt toggles.
    expect(
      zcodeRuntimeCapabilitiesSchema.parse({
        incognitoSession: true,
        incognitoPromptToggles: true,
      }).incognitoPromptToggles,
    ).toBe(true);
    expect(zcodeRuntimeCapabilitiesSchema.parse({}).incognitoPromptToggles).toBeUndefined();
    expect(
      hostCapabilitiesSchema.parse({
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: true,
        compression: "none",
        incognitoSession: true,
        incognitoPromptToggles: true,
      }).incognitoPromptToggles,
    ).toBe(true);
  });

  it("gate failures share the base code and carry a subcode that names the missing flag", () => {
    expect(INCOGNITO_SESSION_UNSUPPORTED_ERROR.startsWith(INCOGNITO_UNSUPPORTED_ERROR)).toBe(true);
    expect(INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR.startsWith(INCOGNITO_UNSUPPORTED_ERROR)).toBe(
      true,
    );
    expect(INCOGNITO_SESSION_UNSUPPORTED_ERROR).not.toBe(
      INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
    );
    expect(PROMPT_TOGGLE_KEYS.every((key) => INCOGNITO_CAPABILITY_KEYS.includes(key))).toBe(true);
  });
});
