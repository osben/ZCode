import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INCOGNITO_CAPABILITY_KEYS,
  INCOGNITO_LOCKDOWN_PROFILE,
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

const { version: _version, ...allOff } = INCOGNITO_LOCKDOWN_PROFILE;
const allOn = Object.fromEntries(INCOGNITO_CAPABILITY_KEYS.map((key) => [key, true]));

describe("incognito profile", () => {
  it("lockdown profile has every capability off", () => {
    expect(INCOGNITO_LOCKDOWN_PROFILE.version).toBe(2);
    expect(INCOGNITO_CAPABILITY_KEYS).toHaveLength(13);
    for (const key of INCOGNITO_CAPABILITY_KEYS) {
      expect(INCOGNITO_LOCKDOWN_PROFILE[key]).toBe(false);
    }
    expect(incognitoProfileSchema.parse(INCOGNITO_LOCKDOWN_PROFILE)).toEqual(
      INCOGNITO_LOCKDOWN_PROFILE,
    );
  });

  it("requires every capability explicitly and rejects unknown keys", () => {
    expect(incognitoProfileSchema.safeParse({ version: 1, skills: true }).success).toBe(false);
    expect(
      incognitoProfileSchema.safeParse({ ...INCOGNITO_LOCKDOWN_PROFILE, extra: true }).success,
    ).toBe(false);
    expect(
      incognitoProfileSchema.safeParse({ ...INCOGNITO_LOCKDOWN_PROFILE, version: 3 }).success,
    ).toBe(false);
    // v2 requires the four v2 toggles; a v1-shaped object is not a v2 profile.
    const {
      identity: _i,
      harness: _h,
      environment: _e,
      automationTools: _a,
      ...v1Shape
    } = INCOGNITO_LOCKDOWN_PROFILE;
    expect(incognitoProfileSchema.safeParse({ ...v1Shape, version: 2 }).success).toBe(false);
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
    expect(
      incognitoProfilesEqual(INCOGNITO_LOCKDOWN_PROFILE, { ...allOff, version: 1, skills: true }),
    ).toBe(false);
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

  it("reads an unparsable stored profile as lockdown, never as a normal session", () => {
    expect(parseStoredIncognitoProfile("{not json")).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    expect(
      parseStoredIncognitoProfile(JSON.stringify({ ...INCOGNITO_LOCKDOWN_PROFILE, version: 3 })),
    ).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    expect(parseStoredIncognitoProfile(JSON.stringify({ version: 2, skills: true }))).toEqual(
      INCOGNITO_LOCKDOWN_PROFILE,
    );
    expect(parseStoredIncognitoProfile(null)).toBeUndefined();
  });

  it("upgrades a stored v1 profile to v2 with the four v2 toggles included (v1 always ran with them)", () => {
    const v1Stored = JSON.stringify({
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
    expect(parseStoredIncognitoProfile(v1Stored)).toEqual({
      ...INCOGNITO_LOCKDOWN_PROFILE,
      version: 2,
      skills: true,
      identity: true,
      harness: true,
      environment: true,
      automationTools: true,
    });
    // A v1 object with an unknown key is not a v1 profile: fail closed.
    expect(
      parseStoredIncognitoProfile(JSON.stringify({ ...JSON.parse(v1Stored), extra: true })),
    ).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
  });

  it("v1 readers reject a v2 profile (an older build falls back to its own lockdown)", () => {
    const v1Reader = {
      version: z.literal(1),
      ...Object.fromEntries(
        INCOGNITO_CAPABILITY_KEYS.filter(
          (key) => !["identity", "harness", "environment", "automationTools"].includes(key),
        ).map((key) => [key, z.boolean()]),
      ),
    };
    expect(z.object(v1Reader).strict().safeParse(INCOGNITO_LOCKDOWN_PROFILE).success).toBe(false);
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
      forkAppSettingsPatchSchema.safeParse({ incognitoDefaults: { ...allOff, version: 1 } })
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

  it("v4 createSession carries a strict resolved profile", () => {
    const result = createEnvelope({ incognito: profile });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.envelope.payload as { incognito?: unknown }).incognito).toEqual(profile);
    }
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

  it("CLI and Host advertise incognito support as an optional capability", () => {
    expect(zcodeRuntimeCapabilitiesSchema.parse({ incognitoSession: true }).incognitoSession).toBe(
      true,
    );
    expect(zcodeRuntimeCapabilitiesSchema.parse({}).incognitoSession).toBeUndefined();
    // The version gate: a CLI without incognitoProfileV2 cannot persist or enforce the v2 toggles.
    expect(
      zcodeRuntimeCapabilitiesSchema.parse({ incognitoSession: true, incognitoProfileV2: true })
        .incognitoProfileV2,
    ).toBe(true);
    expect(zcodeRuntimeCapabilitiesSchema.parse({}).incognitoProfileV2).toBeUndefined();
    expect(
      hostCapabilitiesSchema.parse({
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: true,
        compression: "none",
        incognitoSession: true,
        incognitoProfileV2: true,
      }).incognitoProfileV2,
    ).toBe(true);
  });
});
