import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelClient, ChannelServer, createQueuePair } from "@zcode/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { accountProviderCredentialKey } from "../src/model-provider/accountProviderCredentialKey.js";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-local-services-remote-authority-"));
  tempHomes.push(home);
  return home;
}

function writeLegacyZapiConfig(home: string): void {
  const configDir = join(home, ".zcode", "v2");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        provider: {
          [RETIRED_ZAPI_PROVIDER_ID]: {
            name: "ZAPI",
            kind: "anthropic",
            options: {
              apiKey: "",
              baseURL: "http://192.168.100.166:8080",
            },
            models: {
              "gpt-5.4": {
                limit: { context: 128_000 },
                modalities: {
                  input: ["text"],
                  output: ["text"],
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeZCodeBuiltinProviderConfig(home: string): string {
  const configDir = join(home, ".zcode", "provider-test");
  mkdirSync(configDir, { recursive: true });
  const filePath = join(configDir, "zcodeBuiltin.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        // Composition tests must use the current release contract; the config.json above is the legacy data to migrate.
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf-8",
  );
  return filePath;
}

describe("createLocalServices remote authority", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.resetModules();
    for (const home of tempHomes.splice(0)) {
      // Root cause: on Windows, deleting a directory requires all handles under it to be closed first,
      // while service disposal (log files, config watcher, SQLite handles) drains asynchronously and
      // `force: true` does not retry — it only swallows ENOENT. So afterEach would reliably throw
      // `EPERM, Permission denied: \\?\C:\...\Temp\...` even though the test's own assertions had all
      // passed. POSIX does not surface this because it allows deleting still-open inodes.
      // Use rm's built-in bounded retries to wait for handles to drain; retries only apply to
      // EBUSY/EPERM/ENOTEMPTY and similar codes, and genuine permission failures still throw after
      // retries are exhausted.
      try {
        rmSync(home, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch {
        // In extreme cases handles may still be open. The OS reclaims the temp directory, and a cleanup
        // failure must not fail a test whose assertions already passed.
      }
    }
  });

  it("desktop-attached remote services hide stale ZAPI providers", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    writeLegacyZapiConfig(home);

    const [{ createLocalServices, disposeServiceResourcesAndWait }, { IModelSelectionService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });

    try {
      const providers = (await services.get(IModelSelectionService).getView()).providers;
      expect(providers.some((provider) => provider.id === RETIRED_ZAPI_PROVIDER_ID)).toBe(false);
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("desktop-attached Remote Host 不恢复旧 Model Preset 刷新", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const { createLocalServices, disposeServiceResourcesAndWait } = await import("../src/node.js");
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const requestedUrls = fetchImpl.mock.calls.map(([input]) => String(input));
      expect(requestedUrls.some((url) => url.includes("/releases/latest"))).toBe(false);
      expect(requestedUrls.every((url) => url.includes("/client/configs"))).toBe(true);
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("provider runtime services do not refresh legacy model presets on startup", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const zcodeBuiltinProviderConfigFilePath = writeZCodeBuiltinProviderConfig(home);
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const { createLocalServices, disposeServiceResourcesAndWait } = await import("../src/node.js");
    const services = createLocalServices({ zcodeBuiltinProviderConfigFilePath });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const requestedUrls = fetchImpl.mock.calls.map(([input]) => String(input));
      expect(requestedUrls.some((url) => url.includes("/releases/latest"))).toBe(false);
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("desktop-attached remote 使用远端 Registry 的就绪状态，不等待 Desktop 推送", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const zcodeBuiltinProviderConfigFilePath = writeZCodeBuiltinProviderConfig(home);
    const commandResolver = vi.fn(() => null);
    const [{ createLocalServices, disposeServiceResourcesAndWait }, { IZCodeAgentService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-attached-remote",
      zcodeAgentCommandResolver: commandResolver,
    });

    try {
      await expect(
        services.get(IZCodeAgentService).initialize({ workspacePath: "/remote/workspace" }),
      ).resolves.toMatchObject({ available: false });
      expect(commandResolver).not.toHaveBeenCalled();
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("只在 desktop-attached-remote Environment 暴露 Provisioning target", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const { createLocalServices, disposeServiceResourcesAndWait } = await import("../src/node.js");
    const { IProviderProvisioningTargetService } = await import("../src/index.js");
    const remoteServices = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });
    const localServices = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-local",
    });

    try {
      expect(remoteServices.getOptional(IProviderProvisioningTargetService)).toBeDefined();
      expect(localServices.getOptional(IProviderProvisioningTargetService)).toBeUndefined();
    } finally {
      await disposeServiceResourcesAndWait(remoteServices);
      await disposeServiceResourcesAndWait(localServices);
    }
  });

  it("只在本进程成功持久化 Provisioning Source 事实后通知 Host", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    const onProviderProvisioningSourceChanged = vi.fn();
    const [{ createLocalServices, disposeServiceResourcesAndWait }, serviceDescriptors] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      onProviderProvisioningSourceChanged,
    });

    try {
      await services.get(serviceDescriptors.IProviderSettingsService).createPersonalProvider({
        initialConfig: {
          access: { type: "api-key", apiKey: "key" },
          api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
          personalModelIds: [],
        },
      });
      await services.get(serviceDescriptors.ISettingService).update({ locale: "zh-CN" });
      await services
        .get(serviceDescriptors.ISettingService)
        .update({ providerFamilyDomain: "zai" });
      await services.get(serviceDescriptors.ICredentialService).save("ssh:password", "ignored");
      await services
        .get(serviceDescriptors.ICredentialService)
        .save("oauth:active_provider", "zai");

      expect(onProviderProvisioningSourceChanged.mock.calls).toEqual([
        ["personal-config"],
        ["account-settings"],
        ["credential"],
      ]);
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("keeps the narrow account request auth service private to the host process", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const fetchToken = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      let data: unknown;
      if (url.endsWith("/getCustomerInfo")) {
        data = {
          organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
        };
      } else if (url.endsWith("/api_keys")) {
        data = [{ apiKey: "key-id", name: "zcode-api-key" }];
      } else if (url.endsWith("/api_keys/key-id/access_tokens")) {
        data = {
          accessToken: "current-project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        };
      } else {
        throw new Error(`Unexpected account request: ${url}`);
      }
      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { "content-type": "application/json" },
      });
    });
    const {
      createLocalServices,
      disposeServiceResourcesAndWait,
      getAccountRequestAuthService,
      getOffPeakRequestAuthBuilder,
    } = await import("../src/node.js");
    const { ICredentialService, ISettingService } = await import("../src/index.js");
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
      hostApiNetworkTransport: {
        fetch: fetchToken,
        dispose: vi.fn(),
        disposeAndWait: vi.fn(async () => {}),
      },
    });

    try {
      const accountRequestAuthService = getAccountRequestAuthService(services);
      expect(accountRequestAuthService).toBeDefined();
      expect(getOffPeakRequestAuthBuilder(services)).toBeTypeOf("function");
      const { ProxyChannel } = await import("@zcode/rpc");
      const exposeService = vi.spyOn(ProxyChannel, "fromService");
      const registerChannel = vi.fn();
      services.exposeOnChannelServer({ registerChannel });
      expect(registerChannel).toHaveBeenCalled();
      expect(exposeService).not.toHaveBeenCalledWith(accountRequestAuthService);
      const credentialService = services.get(ICredentialService);
      await services.get(ISettingService).update({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: {
          zai: { kind: "individual-coding-plan" },
        },
      });
      await credentialService.save(
        "oauth:zai:user_info",
        JSON.stringify({ id: "account-a", username: "a", displayName: "Account A" }),
      );
      await credentialService.save("oauth:zai:access_token", "login-token");
      // OAuth only exchanges the login session for a PAT; the old key is kept as a counterexample to prevent composition from falling back to the historical Secret.
      await credentialService.save(
        accountProviderCredentialKey({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          planKind: "individual-coding-plan",
          accountIdentity: "account-a",
        }),
        "legacy-coding-plan-key",
      );

      await expect(
        accountRequestAuthService!.resolveCurrent({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          modelId: "glm-5",
          accountAccess: {
            type: "zhipu-account",
            family: "zai",
            planKind: "individual-coding-plan",
          },
          reason: "model-request",
        }),
      ).resolves.toEqual({
        apiKey: "current-project-token",
        apiKeyId: "key-id",
        accountScope: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const tokenRequest = fetchToken.mock.calls.find(([url]) =>
        String(url).endsWith("/api_keys/key-id/access_tokens"),
      );
      expect(tokenRequest).toBeDefined();
      expect(new Headers(tokenRequest![1]?.headers).get("authorization")).toBe(
        "Bearer login-token",
      );
      expect(fetchToken.mock.calls.some(([url]) => String(url).includes("/copy/"))).toBe(false);
    } finally {
      await disposeServiceResourcesAndWait(services);
    }
  });

  it("复用 Host 注入的网络 transport 并由 ServiceCollection 释放", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const transport = {
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ code: 0, msg: "ok", data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      dispose: vi.fn(),
      disposeAndWait: vi.fn(async () => {}),
    };
    const [{ createLocalServices, disposeServiceResourcesAndWait }, { IClientScenesService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      hostApiNetworkTransport: transport,
      serviceAuthorityMode: "desktop-attached-remote",
    });

    try {
      await expect(services.get(IClientScenesService).list()).resolves.toMatchObject({
        code: 0,
        data: [],
      });
      expect(transport.fetch).toHaveBeenCalledOnce();
    } finally {
      await disposeServiceResourcesAndWait(services);
    }

    expect(transport.disposeAndWait).toHaveBeenCalledOnce();
  });

  it("exposes plugin sync through the local RPC server", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const [{ createLocalServices, disposeServiceResourcesAndWait }, { IPluginSyncService }] =
      await Promise.all([import("../src/node.js"), import("../src/index.js")]);
    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: writeZCodeBuiltinProviderConfig(home),
      serviceAuthorityMode: "desktop-attached-remote",
    });
    const [clientProtocol, serverProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test", 50);
    const client = new ChannelClient(clientProtocol);

    try {
      services.exposeOnChannelServer(server);
      const result = await client
        .getChannel(IPluginSyncService.channelName)
        .call("listLocalUserPluginCandidates", []);

      expect(result.candidates).toEqual([]);
      expect(result.maxArchiveBytes).toBeGreaterThan(0);
    } finally {
      client.dispose();
      server.dispose();
      await disposeServiceResourcesAndWait(services);
    }
  });
});
