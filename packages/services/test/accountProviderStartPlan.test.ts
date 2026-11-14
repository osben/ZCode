import { describe, expect, it, vi } from "vitest";
import type { ProviderFamilyDomain } from "@zcode/shared";
import { resolveStartPlanFamilyFromOAuthProvider } from "@zcode/shared";
import {
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
  type AccountProviderConnectionSettings,
} from "#src/model-provider/accountProviderConnectionResolver.js";
import type { OAuthStartPlanMaterial } from "#src/oauth/repo/oauthCredentialRepo.js";

// Upstream 3.18.2 (reconstructed): Start Plan follows the signed-in login, including zai_cn → bigmodel.
const zaiCnMaterial: OAuthStartPlanMaterial = {
  family: "bigmodel",
  loginProvider: "zai_cn",
  zcodeUserId: "user-1",
  sessionRevision: "rev-1",
  accountIdentity: "user-1",
  zcodeJwtToken: "jwt-1",
};

const noDomain: AccountProviderConnectionSettings = { providerFamilyDomain: null, selections: {} };

function startPlanLoader(material: OAuthStartPlanMaterial | null) {
  return async (family: ProviderFamilyDomain) => (material?.family === family ? material : null);
}

/** ProviderConfigMap.entries() returns an array; the resolver relies on that. */
function providerMap(entries: readonly (readonly [string, unknown])[]) {
  return { entries: () => [...entries] };
}

function zhipuProvider(accountType: ProviderFamilyDomain, mode: string) {
  return { access: { type: "zhipu-account", accountType, mode } };
}

describe("resolveStartPlanFamilyFromOAuthProvider", () => {
  it("maps zai_cn to bigmodel and keeps the family mapping otherwise", () => {
    expect(resolveStartPlanFamilyFromOAuthProvider("zai_cn")).toBe("bigmodel");
    expect(resolveStartPlanFamilyFromOAuthProvider("zai")).toBe("zai");
    expect(resolveStartPlanFamilyFromOAuthProvider("bigmodel")).toBe("bigmodel");
    expect(resolveStartPlanFamilyFromOAuthProvider("github")).toBeNull();
  });
});

describe("resolveCurrentAccountAccess for Start Plan", () => {
  it("grants the bigmodel Start Plan to a zai_cn login with no family domain", async () => {
    const access = await resolveCurrentAccountAccess({
      access: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" },
      readSettings: async () => noDomain,
      loadAccountIdentity: async () => null,
      loadStartPlanMaterial: startPlanLoader(zaiCnMaterial),
    });
    expect(access).toEqual({ type: "zhipu-account", family: "bigmodel", planKind: "start-plan" });
  });

  it("follows the selected family domain over the login family", async () => {
    const access = await resolveCurrentAccountAccess({
      access: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" },
      readSettings: async () => ({ providerFamilyDomain: "zai", selections: {} }),
      loadAccountIdentity: async () => null,
      loadStartPlanMaterial: startPlanLoader(zaiCnMaterial),
    });
    expect(access).toBeNull();
  });

  it("denies Start Plan without an identity", async () => {
    const access = await resolveCurrentAccountAccess({
      access: { type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" },
      readSettings: async () => noDomain,
      loadAccountIdentity: async () => null,
      loadStartPlanMaterial: startPlanLoader({ ...zaiCnMaterial, accountIdentity: " " }),
    });
    expect(access).toBeNull();
  });
});

describe("account provider connection resolver for Start Plan", () => {
  function createResolver(material: OAuthStartPlanMaterial | null) {
    const resolveFamilyAvailability = vi.fn(
      async ({ providers }: { providers: readonly { providerId: string }[] }) =>
        Object.fromEntries(providers.map(({ providerId }) => [providerId, { kind: "available" }])),
    );
    const loadCodingPlanApiKey = vi.fn(async () => "key");
    const resolver = createAccountProviderConnectionResolver({
      loadSessionRevision: async () => "rev-1",
      readSettings: async () => noDomain,
      loadCodingPlanApiKey,
      loadAccountIdentity: async () => null,
      loadStartPlanMaterial: startPlanLoader(material),
      resolveFamilyAvailability: resolveFamilyAvailability as never,
    });
    return { resolver, resolveFamilyAvailability, loadCodingPlanApiKey };
  }

  it("reports a zai_cn bigmodel Start Plan as available and current; paid plans stay not-connected", async () => {
    const { resolver, resolveFamilyAvailability, loadCodingPlanApiKey } =
      createResolver(zaiCnMaterial);
    const configuredProviders = providerMap([
      ["bigmodel-start", zhipuProvider("bigmodel", "start-plan")],
      ["bigmodel-personal", zhipuProvider("bigmodel", "individual-coding-plan")],
    ]);

    const connections = await resolver({ configuredProviders } as never);

    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "bigmodel-start",
          status: "available",
          current: true,
        }),
        expect.objectContaining({
          providerId: "bigmodel-personal",
          status: "unavailable",
          unavailableReason: "not-connected",
          current: false,
        }),
      ]),
    );
    expect(resolveFamilyAvailability).toHaveBeenCalledTimes(1);
    expect(resolveFamilyAvailability.mock.calls[0]![0].providers).toEqual([
      expect.objectContaining({ providerId: "bigmodel-start", apiKey: null }),
    ]);
    // Personal-plan keys load only with a family identity, which a zai_cn login does not have.
    expect(loadCodingPlanApiKey).not.toHaveBeenCalled();
  });

  it("reports Start Plan as not-connected without a login", async () => {
    const { resolver, resolveFamilyAvailability } = createResolver(null);
    const configuredProviders = providerMap([
      ["bigmodel-start", zhipuProvider("bigmodel", "start-plan")],
    ]);

    const connections = await resolver({ configuredProviders } as never);

    expect(connections).toEqual([
      expect.objectContaining({
        providerId: "bigmodel-start",
        status: "unavailable",
        unavailableReason: "not-connected",
        current: false,
      }),
    ]);
    expect(resolveFamilyAvailability).not.toHaveBeenCalled();
  });
});

describe("coding plan family availability for Start Plan", () => {
  it("authorizes the bigmodel Start Plan with the zai_cn login JWT when there is no family material", async () => {
    const authorizations: (string | null)[] = [];
    const apiClient = {
      request: vi.fn(async (_input: unknown, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: { plans: [{ status: "active", plan_id: "zcode-v3-start-plan" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    };
    const resolveAvailability = createCodingPlanFamilyAvailabilityResolver({
      apiClient: apiClient as never,
      loadOAuthAccountMaterial: async () => null,
      loadStartPlanMaterial: startPlanLoader(zaiCnMaterial),
    });

    const result = await resolveAvailability({
      family: "bigmodel",
      providers: [
        { providerId: "bigmodel-start", family: "bigmodel", planKind: "start-plan", apiKey: null },
      ],
      selections: {},
    });

    expect(authorizations).toEqual(["Bearer jwt-1"]);
    expect(result["bigmodel-start"]).toMatchObject({ kind: "available" });
  });
});
