/* OMCP-005/006/009/021/023/024/026/027 — official MCP credential resolution and identity header construction (spec §6.1 / §6.2.1 / §6.3.3).
 *
 * OMCP-025 (Off-Peak zero regression, verifying the isolation in §6.1.1) is not a test case in this
 * file but a regression action:
 *   npx vitest run packages/services/test/offPeakRuntimeModel.test.ts \
 *     packages/services/test/offPeakServerClient.test.ts \
 *     packages/services/test/offPeakTaskService.test.ts \
 *     packages/services/test/offPeakE2eIntegration.test.ts \
 *     packages/services/test/offPeakClientConfig.test.ts \
 *     packages/services/test/offPeakTaskRepo.test.ts
 * After this implementation, all 6 files / 77 tests are green and no exports of offPeakRuntimeModel.ts were modified.
 */
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type ZCodeAccountAccess } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";

// Log-level assertions for credential resolution (OMCP-LOG-*): serviceLogger must be mocked to
// observe the module-level `const log` calls; the other cases in this file do not assert on logs,
// so the mock is transparent to them.
const { serviceInfo } = vi.hoisted(() => ({ serviceInfo: vi.fn() }));

vi.mock("#src/logger/serviceLogger.js", () => ({
  createServiceLogger: () => ({
    debug: vi.fn(),
    info: serviceInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  buildOfficialMcpAuthHeaders,
  createCredentialResolvedLogKey,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
  type OfficialMcpCredentialResolverDeps,
} from "../src/official-mcp/officialMcpCredentials.js";

const JWT = "zcode-jwt-value";
/** MaaS login JWT: Coding Plan credentials have used this channel since 2026-08 (X-Bigmodel-Authorization). */
const MAAS_JWT = "bigmodel-maas-jwt";
const ZAI_MAAS_JWT = "zai-maas-jwt";

function createRegistry(
  providers: Array<{ providerId: string; config: { access: Record<string, unknown> } }>,
): ModelSelectionView {
  return { revision: 1, providers } as unknown as ModelSelectionView;
}

function individualProvider(family: "zai" | "bigmodel") {
  return {
    providerId:
      family === "zai"
        ? BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    config: {
      access: {
        type: "zhipu-account",
        accountType: family,
        mode: "individual-coding-plan",
        entitled: true,
      },
    },
  };
}

function teamProvider(family: "zai" | "bigmodel") {
  return {
    providerId:
      family === "zai"
        ? BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    config: {
      access: {
        type: "zhipu-account",
        accountType: family,
        mode: "team-coding-plan",
        entitled: true,
      },
    },
  };
}

interface DepsOverrides {
  activeProvider?: string | null;
  activeProviderSequence?: Array<string | null>;
  jwt?: string | null;
  /** JWTs returned in sequence, simulating token rotation during registry reads (SG-01). */
  jwtSequence?: Array<string | null>;
  /** Overrides `oauth:<provider>:access_token` (the MaaS login JWT). */
  maasJwt?: string | null;
  /** MaaS JWTs returned in sequence, simulating their rotation during registry reads. */
  maasJwtSequence?: Array<string | null>;
  registry?: ModelSelectionView;
  registrySequence?: ModelSelectionView[];
  settings?: Record<string, unknown>;
  settingsSequence?: Array<Record<string, unknown>>;
  accountAccess?: ZCodeAccountAccess | null;
  accountAccessSequence?: Array<ZCodeAccountAccess | null>;
}

function createDeps(overrides: DepsOverrides = {}): OfficialMcpCredentialResolverDeps {
  let activeProviderCalls = 0;
  let jwtCalls = 0;
  let maasJwtCalls = 0;
  let registryCalls = 0;
  let accountAccessCalls = 0;
  return {
    accountRequestAuthService: {
      resolveAccessCurrent: async (access) => {
        if (overrides.accountAccessSequence) {
          const value =
            overrides.accountAccessSequence[
              Math.min(accountAccessCalls, overrides.accountAccessSequence.length - 1)
            ];
          accountAccessCalls += 1;
          return value ?? null;
        }
        if (overrides.accountAccess !== undefined) return overrides.accountAccess;
        return access.mode === "individual-coding-plan"
          ? {
              type: "zhipu-account" as const,
              family: access.accountType,
              planKind: "individual-coding-plan" as const,
            }
          : null;
      },
    },
    credentialService: {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          if (overrides.activeProviderSequence) {
            const value =
              overrides.activeProviderSequence[
                Math.min(activeProviderCalls, overrides.activeProviderSequence.length - 1)
              ];
            activeProviderCalls += 1;
            return value ?? null;
          }
          return overrides.activeProvider === undefined ? "bigmodel" : overrides.activeProvider;
        }
        if (key === "zcodejwttoken") {
          if (overrides.jwtSequence) {
            const value =
              overrides.jwtSequence[Math.min(jwtCalls, overrides.jwtSequence.length - 1)];
            jwtCalls += 1;
            return value ?? null;
          }
          return overrides.jwt === undefined ? JWT : overrides.jwt;
        }
        // The MaaS login JWT is keyed exactly by family; cross-family fallback is forbidden.
        if (key === "oauth:bigmodel:access_token" || key === "oauth:zai:access_token") {
          if (overrides.maasJwtSequence) {
            const value =
              overrides.maasJwtSequence[
                Math.min(maasJwtCalls, overrides.maasJwtSequence.length - 1)
              ];
            maasJwtCalls += 1;
            return value ?? null;
          }
          if (overrides.maasJwt !== undefined) return overrides.maasJwt;
          return key === "oauth:zai:access_token" ? ZAI_MAAS_JWT : MAAS_JWT;
        }
        return null;
      },
    },
    modelSelectionService: {
      getView: async () => {
        const fallback = overrides.registry ?? createRegistry([individualProvider("bigmodel")]);
        const value =
          overrides.registrySequence?.[
            Math.min(registryCalls, overrides.registrySequence.length - 1)
          ];
        registryCalls += 1;
        return value ?? fallback;
      },
    },
  };
}

describe("official mcp credential resolver", () => {
  it("OMCP-021: emits PERSONAL target type for a personal coding plan", async () => {
    const outcome = await resolveOfficialMcpCredentials(createDeps());
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.planScope).toEqual({ targetType: "PERSONAL" });
    expect(outcome.snapshot.wireScope).toEqual({ targetType: "PERSONAL" });
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
      "Bigmodel-Target-Type": "PERSONAL",
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
    // The legacy channel must be gone entirely: sending both headers makes the server additionally
    // validate API key ownership, and a single expired key would 403 the whole request.
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)["X-Coding-Plan-Api-Key"]).toBeUndefined();
  });

  it("OMCP-005/021: emits TEAM target type with paired identity for a BigModel team plan", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([teamProvider("bigmodel")]),
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "coding",
          organizationId: "org-1",
          projectId: "project-1",
        },
        settings: {
          providerFamilyConnectionSelections: {
            bigmodel: {
              kind: "team-coding-plan",
              productId: "coding",
              organizationId: "org-1",
              projectId: "project-1",
            },
          },
          providerFamilyDomain: "bigmodel",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot).toMatchObject({
      planScope: {
        organizationId: "org-1",
        projectId: "project-1",
        targetType: "TEAM",
      },
      wireScope: {
        organizationId: "org-1",
        projectId: "project-1",
        targetType: "TEAM",
      },
    });
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
      "Bigmodel-Organization": "org-1",
      "Bigmodel-Project": "project-1",
      "Bigmodel-Target-Type": "TEAM",
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
  });

  it("OMCP-006: wireScope=null never emits partial team headers", () => {
    expect(
      buildOfficialMcpAuthHeaders({
        codingPlanAuthorization: MAAS_JWT,
        jwt: JWT,
        planScope: null,
        providerFamily: "bigmodel",
        wireScope: null,
      }),
    ).toEqual({
      Authorization: `Bearer ${JWT}`,
      "X-Bigmodel-Authorization": `Bearer ${MAAS_JWT}`,
    });
  });

  it("OMCP-021: keeps zai-team consistent with Off-Peak by omitting Target-Type entirely", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        activeProvider: "zai",
        registry: createRegistry([teamProvider("zai")]),
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "team-coding-plan",
          productId: "coding",
          organizationId: "org-z",
          projectId: "project-z",
        },
        settings: {
          providerFamilyConnectionSelections: {
            zai: {
              kind: "team-coding-plan",
              productId: "coding",
              organizationId: "org-z",
              projectId: "project-z",
            },
          },
          providerFamilyDomain: "zai",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.planScope).toEqual({
      organizationId: "org-z",
      projectId: "project-z",
      targetType: "TEAM",
    });
    expect(outcome.snapshot.wireScope).toBeNull();
    const headers = buildOfficialMcpAuthHeaders(outcome.snapshot);
    expect(headers["Bigmodel-Target-Type"]).toBeUndefined();
    expect(headers["Bigmodel-Organization"]).toBeUndefined();
    expect(headers["Bigmodel-Project"]).toBeUndefined();
  });

  it("OMCP-023: sends only the ZCode JWT for a Start Plan connection", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
            config: {
              access: {
                type: "zhipu-account",
                family: "bigmodel",
                mode: "start-plan",
              },
            },
          },
        ]),
      }),
    );
    expect(outcome).toEqual({
      ok: true,
      snapshot: {
        jwt: JWT,
        planScope: null,
        providerFamily: "bigmodel",
        wireScope: null,
      },
    });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
    });
  });

  it("OMCP-009: reports unavailable when not logged in and plan-required without Account Access", async () => {
    await expect(resolveOfficialMcpCredentials(createDeps({ jwt: "" }))).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
    await expect(
      resolveOfficialMcpCredentials(
        createDeps({
          accountAccess: null,
          registry: createRegistry([individualProvider("bigmodel")]),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "official_auth_plan_required" });
  });

  it("rejects a login identity that does not match the selected family", async () => {
    // A ZAI JWT combined with a BigModel key in one request could only be rejected by server-side business validation; it is blocked up front here.
    await expect(
      resolveOfficialMcpCredentials(createDeps({ activeProvider: "zai" })),
    ).resolves.toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("sends only the ZCode JWT when the selected coding plan connection is absent", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ registry: createRegistry([]) }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)).toEqual({
      Authorization: `Bearer ${JWT}`,
    });
  });

  it("does not require a MaaS JWT when no Coding Plan provider is selected", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ maasJwt: null, registry: createRegistry([]) }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.codingPlanAuthorization).toBeUndefined();
  });

  it("rejects an identity-only snapshot while the active provider remains unstable", async () => {
    await expect(
      resolveOfficialMcpCredentials(
        createDeps({
          activeProviderSequence: ["bigmodel", "zai", "bigmodel", "zai"],
          registry: createRegistry([]),
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("still resolves when the connection exists but its business key is absent", async () => {
    // Behavior change (2026-08): the business key is no longer a credential, so it is no longer a gate.
    // Previously the transient "key is being refreshed" state was misjudged as "no plan", blocking
    // locally a call that would have succeeded.
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([individualProvider("bigmodel")]),
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(buildOfficialMcpAuthHeaders(outcome.snapshot)["X-Bigmodel-Authorization"]).toBe(
      `Bearer ${MAAS_JWT}`,
    );
  });

  it("reports official_auth_unavailable when the MaaS login JWT is missing", async () => {
    // The login state is incomplete (re-login needed), not "no plan" — both provider adapters
    // strictly require writing this token at login, so this mostly shows up in legacy login
    // states carried over from migration.
    await expect(resolveOfficialMcpCredentials(createDeps({ maasJwt: "" }))).resolves.toEqual({
      ok: false,
      reason: "official_auth_unavailable",
    });
  });

  it("takes the MaaS JWT of the selected family, never the other one", async () => {
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        activeProvider: "zai",
        registry: createRegistry([individualProvider("zai")]),
        settings: {
          providerFamilyConnectionSelections: {
            zai: { kind: "individual-coding-plan" },
          },
          providerFamilyDomain: "zai",
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    // Cross-family fallback would send a request destined to fail, with a failure reason pointing at the misleading "no plan" conclusion.
    expect(outcome.snapshot.codingPlanAuthorization).toBe(ZAI_MAAS_JWT);
    expect(outcome.snapshot.codingPlanAuthorization).not.toBe(MAAS_JWT);
  });

  it("re-resolves once when the selection changes mid-flight, then gives up", async () => {
    // Inconsistent before/after fingerprints force a retry; two generations of credentials are never stitched together. If both rounds stay unstable, report unavailable.
    const flipping = [
      createRegistry([individualProvider("bigmodel")]),
      createRegistry([individualProvider("zai")]),
    ];
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ registrySequence: [flipping[0]!, flipping[1]!, flipping[0]!, flipping[1]!] }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("动态 Team scope 在解析前后变化时不拼接两代身份", async () => {
    const teamAccess = (projectId: string): ZCodeAccountAccess => ({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "team-coding-plan",
      productId: "coding",
      organizationId: "org-1",
      projectId,
    });
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        registry: createRegistry([teamProvider("bigmodel")]),
        accountAccessSequence: [
          teamAccess("project-a"),
          teamAccess("project-b"),
          teamAccess("project-a"),
          teamAccess("project-b"),
        ],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("SG-01: discards the round when the JWT rotates during the registry read", async () => {
    // Read order per round: first JWT -> registry -> re-read JWT for the consistency check.
    // Four distinct values make the before/after reads differ in **both** rounds, so the result
    // is unavailable — never a mixed-generation "old JWT + new key" snapshot.
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        jwtSequence: ["jwt-gen-1", "jwt-gen-2", "jwt-gen-3", "jwt-gen-4"],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("discards the round when the MaaS JWT rotates during the registry read", async () => {
    // Same idea as above: the MaaS JWT is now a real Coding Plan credential and must be included in the
    // before/after consistency check, or a mixed-generation "old zcode JWT + new MaaS JWT" snapshot could be assembled.
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({
        maasJwtSequence: ["maas-gen-1", "maas-gen-2", "maas-gen-3", "maas-gen-4"],
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
  });

  it("SG-01: accepts the snapshot when the JWT stays stable across the registry read", async () => {
    // The 1st and 2nd reads agree (same generation); resolution must succeed and the snapshot uses that JWT.
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ jwtSequence: ["jwt-stable", "jwt-stable"] }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.jwt).toBe("jwt-stable");
  });

  it("SG-01: recovers when the JWT rotates once and then settles", async () => {
    // Round 1 is inconsistent (gen1 -> gen2); round 2 is stable at gen2, so resolution finally succeeds using gen2.
    const outcome = await resolveOfficialMcpCredentials(
      createDeps({ jwtSequence: ["jwt-gen-1", "jwt-gen-2", "jwt-gen-2", "jwt-gen-2"] }),
    );
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) return;
    expect(outcome.snapshot.jwt).toBe("jwt-gen-2");
  });

  it("OMCP-024: has no mock credential branch at all", async () => {
    // The Off-Peak ZCODE_OFFPEAK_MOCK placeholder credential branch must not reappear in the official MCP path.
    const previous = process.env["ZCODE_OFFPEAK_MOCK"];
    process.env["ZCODE_OFFPEAK_MOCK"] = "1";
    try {
      const outcome = await resolveOfficialMcpCredentials(createDeps({ jwt: "" }));
      expect(outcome).toEqual({ ok: false, reason: "official_auth_unavailable" });
      const ok = await resolveOfficialMcpCredentials(createDeps());
      expect(ok).toMatchObject({ ok: true });
      if (!ok.ok) return;
      expect(ok.snapshot.jwt).toBe(JWT);
      expect(ok.snapshot.codingPlanAuthorization).toBe(MAAS_JWT);
    } finally {
      if (previous === undefined) delete process.env["ZCODE_OFFPEAK_MOCK"];
      else process.env["ZCODE_OFFPEAK_MOCK"] = previous;
    }
  });

  it("OMCP-026: dedupes concurrent resolves into a single underlying resolution", async () => {
    const deps = createDeps();
    const spy = vi.spyOn(deps.modelSelectionService, "getView");
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    const results = await Promise.all([
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
      resolver.resolveHeaders(),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it("OMCP-027: re-resolves after settle, so a connection switch is picked up", async () => {
    const deps = createDeps();
    const spy = vi.spyOn(deps.modelSelectionService, "getView");
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    await resolver.resolveHeaders();
    await resolver.resolveHeaders();
    // No time-based caching: two sequential calls must each resolve once
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("clears the in-flight slot when a resolution throws", async () => {
    let shouldThrow = true;
    const deps = createDeps();
    deps.modelSelectionService.getView = async () => {
      if (shouldThrow) throw new Error("registry unavailable");
      return createRegistry([individualProvider("bigmodel")]);
    };
    const resolver = createOfficialMcpAuthHeadersResolver(deps);
    await expect(resolver.resolveHeaders()).rejects.toThrow("registry unavailable");
    shouldThrow = false;
    // A failed Promise must not be reused permanently by later requests
    await expect(resolver.resolveHeaders()).resolves.toMatchObject({ ok: true });
  });
});

/* OMCP-LOG — credential-resolution success log: info level with hourly bucket dedup (spec §4 audit rules).
 *
 * Background: the MaaS JWT has no refresh path; server-side expiry collapses into 3101
 * "coding plan is required" (user incident on 2026-09-12). Remaining validity is the only clue the
 * client can prove by itself, so it must be logged at info (production debug is not persisted);
 * but resolution happens as often as official MCP requests, so it must be deduped (see
 * createCredentialResolvedLogKey).
 */
describe("official mcp credential resolved log", () => {
  it("OMCP-LOG-01: dedup key buckets expiry by hour and separates family/scope", () => {
    const personal = { providerFamily: "bigmodel", planTargetType: "PERSONAL" } as const;
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: 3600 }),
    ).toBe("bigmodel|PERSONAL|t1");
    // Bucket boundary: 3599 falls in t0, crossing 3600 moves to t1
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: 3599 }),
    ).toBe("bigmodel|PERSONAL|t0");
    // Expired (≤0) and unparsable (undefined) are separate buckets: crossing zero or a token shape change always yields a new key
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: -5 }),
    ).toBe("bigmodel|PERSONAL|expired");
    expect(
      createCredentialResolvedLogKey({ ...personal, maasJwtExpiresInSeconds: undefined }),
    ).toBe("bigmodel|PERSONAL|unparsable");
    expect(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: null,
        maasJwtExpiresInSeconds: 100,
      }),
    ).toBe("zai|none|t0");
    // PERSONAL↔TEAM switching changes identity-header semantics and must be distinguishable
    expect(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: "TEAM",
        maasJwtExpiresInSeconds: 100,
      }),
    ).not.toBe(
      createCredentialResolvedLogKey({
        providerFamily: "zai",
        planTargetType: "PERSONAL",
        maasJwtExpiresInSeconds: 100,
      }),
    );
  });

  it("OMCP-LOG-02: logs jwt expiry at info level and dedupes same-bucket re-resolves", async () => {
    // 123456s ≈ 34.3h, the t34 bucket: other cases in this file use fake tokens whose exp cannot be
    // parsed (unparsable bucket), so a unique bucket value guarantees this test's first call is not
    // swallowed by the module-level dedup key regardless of test execution order.
    const deps = createDeps({ maasJwt: makeMaasJwtWithExpiry(123456) });
    serviceInfo.mockClear();
    const first = await resolveOfficialMcpCredentials(deps);
    expect(first.ok).toBe(true);
    const resolvedCalls = () =>
      serviceInfo.mock.calls.filter(
        (call): call is [string, Record<string, unknown>] =>
          call[0] === "official mcp credentials resolved",
      );
    expect(resolvedCalls()).toHaveLength(1);
    const fields = resolvedCalls()[0]![1]!;
    expect(fields).toMatchObject({
      providerFamily: "bigmodel",
      planTargetType: "PERSONAL",
      wireTargetType: "PERSONAL",
    });
    expect(fields["maasJwtExpiresInSeconds"]).toBeGreaterThan(123_000);
    expect(fields["maasJwtExpiresInSeconds"]).toBeLessThan(123_900);

    // The resolver has no time-based cache; repeated resolutions in the same bucket (the two tokens
    // are built 0-1s apart, both landing in t34) must not log again — otherwise log volume would grow
    // in lockstep with official MCP request counts.
    const second = await resolveOfficialMcpCredentials(
      createDeps({ maasJwt: makeMaasJwtWithExpiry(123456) }),
    );
    expect(second.ok).toBe(true);
    expect(resolvedCalls()).toHaveLength(1);
  });

  it("OMCP-LOG-03: identity-only degradation stays out of info logs", async () => {
    // Logged in but the registry has no coding plan provider, so the identity-only degradation still logs at debug
    // and produces no info noise (this upgrade covers only successful resolutions carrying a MaaS JWT).
    const deps = createDeps({ registry: createRegistry([]) });
    const outcome = await resolveOfficialMcpCredentials(deps);
    expect(outcome).toMatchObject({ ok: true });
    expect(
      serviceInfo.mock.calls.filter((call) => String(call[0]).includes("identity-only")),
    ).toHaveLength(0);
  });
});

/** Builds a three-part MaaS JWT whose exp can be parsed by readJwtExpiresInSeconds (base64url payload). */
function makeMaasJwtWithExpiry(expiresInSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.round(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}
