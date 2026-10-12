import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceChannels } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

async function createProviderFixture(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  tempHomes.push(home);
  process.env.HOME = home;
  const filePath = join(home, "zcode-builtin.json");
  // Fix rationale: passing only {} made background provider initialization read an undefined path and emit error logs.
  // Use an empty config matching the current Release contract so composition tests stay independent of real user config and release files.
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
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
    "utf8",
  );
  return filePath;
}

describe("conversation share service composition", () => {
  beforeEach(() => {
    // Keep real log output while letting background initialization errors still fail the test.
    vi.spyOn(console, "error");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ code: 0, data: { configs: {} } }),
    );
  });

  afterEach(async () => {
    try {
      for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it("registers a real API-backed service for a local desktop host", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({ zcodeBuiltinProviderConfigFilePath });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      const service = services.get(servicesModule.IConversationShareService);
      expect(typeof service.getCapabilities).toBe("function");
      expect(ServiceChannels.ConversationShare).toBe("conversation-share");
    } finally {
      // Fix rationale: deleting HOME right after a synchronous dispose lets still-draining init/dispose
      // tasks write logs late and race with the Vitest worker shutting down its log RPC; await service
      // disposal first, then let afterEach clean up the directory.
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });

  it("keeps desktop-attached remote hosts behind the publishing boundary", async () => {
    const zcodeBuiltinProviderConfigFilePath = await createProviderFixture(
      "zcode-conversation-share-remote-",
    );
    const [nodeModule, servicesModule] = await Promise.all([
      import("@zcode/services/node"),
      import("@zcode/services"),
    ]);

    const services = nodeModule.createLocalServices({
      zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "desktop-attached-remote",
    });
    try {
      await expect(
        services.get(servicesModule.IModelSelectionService).getView(),
      ).resolves.toMatchObject({
        providers: [],
      });
      await expect(
        services.get(servicesModule.IConversationShareService).getCapabilities(),
      ).rejects.toMatchObject({ kind: "feature_disabled" });
    } finally {
      await nodeModule.disposeServiceResourcesAndWait(services);
    }
  });
});
