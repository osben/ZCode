import {
  AccountProviderService,
  ModelConfigRules,
  ProviderConfigMap,
  type AccountProviderResolver,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  BIGMODEL_PROVIDER_ID,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";
import { createOAuthProviderLogoutHandler } from "../src/oauth/oauthProviderLogout.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";

const CONFIG_SNAPSHOT: ProviderConfigSnapshot = {
  revision: "config-1",
  zcodeBuiltinRevision: "builtin-1",
  personalRevision: "personal-1",
  zcodeBuiltinProviders: ProviderConfigMap.empty(),
  personalProviders: ProviderConfigMap.empty(),
  zcodeBuiltinModelRules: ModelConfigRules.empty(),
  personalModels: ModelConfigRules.empty(),
};

const staticConfigSource: ProviderSource<ProviderConfigSnapshot> = {
  read: async () => CONFIG_SNAPSHOT,
  onDidChange: () => () => {},
};

function createCorruptCredentialService(): ICredentialService {
  return {
    load: async (key: string) => {
      if (key === "oauth:active_provider") {
        throw Object.assign(new Error("Serialized credential decrypt failure"), {
          code: CREDENTIAL_DECRYPT_ERROR_CODE,
        });
      }
      return `${key}-value`;
    },
    save: async () => {},
    delete: async () => {},
  };
}

describe("OAuthCredentialRepo corrupt session cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves null while the derived cleanup never settles, and reports the known provider ids once", async () => {
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    const repo = new OAuthCredentialRepo(createCorruptCredentialService(), {
      onCorruptOAuthSessionCleared: cleanup,
    });

    await expect(repo.getActiveProvider()).resolves.toBeNull();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]),
    );
  });

  it("keeps recovery successful when the detached cleanup rejects and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repo = new OAuthCredentialRepo(createCorruptCredentialService(), {
      onCorruptOAuthSessionCleared: async () => {
        throw new Error("derived cleanup failed");
      },
    });

    await expect(repo.getActiveProvider()).resolves.toBeNull();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("oauthCredentialRepo");
  });
});

describe("corrupt session recovery and account provider refresh", () => {
  it("does not queue a login refresh behind corrupt-session cleanup", async () => {
    // The resolver never settles for logout refreshes. A regression that enqueues the corrupt-path
    // cleanup into the single-flight refresh queue leaves the login refresh pending forever.
    const seenReasons: string[][] = [];
    const resolve: AccountProviderResolver = async ({ reasons }) => {
      seenReasons.push([...reasons]);
      if (reasons.some((reason) => reason.startsWith("oauth-logout:"))) {
        return new Promise<never>(() => {});
      }
      return { providers: ProviderConfigMap.empty(), states: {} };
    };
    const accountProviders = new AccountProviderService({
      configSource: staticConfigSource,
      resolve,
    });
    const oauth = new OAuthService(createCorruptCredentialService(), {
      adapters: [],
      onProviderLogout: createOAuthProviderLogoutHandler({
        accountProviderCredentialStore: { deleteApiKey: async () => {} },
        refreshAccountProviders: (reason) => accountProviders.refresh(reason),
      }),
    });

    await accountProviders.read();
    await expect(oauth.restoreCachedSessionState()).resolves.toEqual({ status: "signed-out" });

    await expect(accountProviders.refresh("oauth-callback")).resolves.toBeDefined();
    expect(seenReasons.flat().filter((reason) => reason.startsWith("oauth-logout:"))).toEqual([]);
    accountProviders.dispose();
  }, 2000);
});
