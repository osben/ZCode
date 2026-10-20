import { BUILTIN_MODEL_PROVIDER_IDS, type AppSettings, type OAuthProviderId } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";

function createServices(params: {
  settings?: Partial<AppSettings>;
  activeProvider?: OAuthProviderId | null;
  selectableProviderIds?: string[];
}) {
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {});
  return {
    settingService: {
      get: vi.fn(async () => ({
        recentProjects: [],
        locale: "en-US" as const,
        modelProviderFamilyModes: {},
        providerFamilyDomainMigrated: false,
        ...params.settings,
      })),
      update,
    },
    oauthService: {
      getActiveProvider: vi.fn(async () => params.activeProvider ?? null),
    },
    modelSelectionService: {
      getView: vi.fn(async () => ({
        revision: 1,
        providers: (params.selectableProviderIds ?? []).map((providerId) => ({
          providerId,
          config: {
            access: { type: "api-key" as const, apiKey: "test-key" },
          },
          models: [],
        })),
      })),
    },
    update,
  };
}

describe("ensureProviderFamilyDomainMigration", () => {
  it("migrates providerFamilyDomain from the previous active OAuth provider", async () => {
    const services = createServices({ activeProvider: "zai" });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomain: "zai",
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("infers from the only available account provider when there is no active OAuth", async () => {
    const services = createServices({
      selectableProviderIds: [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomain: "zai",
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("only marks migrated without guessing the domain when both sides have usable credentials", async () => {
    const services = createServices({
      selectableProviderIds: [
        BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      ],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        providerFamilyDomain: expect.any(String),
      }),
    );
    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("does not mark migrated while neither the active provider nor the provider cache has recovered", async () => {
    const services = createServices({
      activeProvider: null,
      selectableProviderIds: [],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).not.toHaveBeenCalled();
  });

  it("does not migrate again when providerFamilyDomain already exists", async () => {
    const services = createServices({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyDomainMigrated: true,
      },
      activeProvider: "zai",
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).not.toHaveBeenCalled();
  });
});
