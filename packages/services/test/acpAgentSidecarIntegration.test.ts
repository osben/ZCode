import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAcpPseudoModelConfig,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  type ProviderSettingsView,
} from "@zcode/provider";
import {
  NodeForkAcpAgentStore,
  encodeProviderConfigFile,
  resolveForkAcpAgentsFilePath,
} from "@zcode/provider-node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

// specs/acp-agent-runtime.md "Storage and upstream compatibility": ACP agents live in the fork
// sidecar; the upstream-shared provider_config.json never receives an acp: entry.

let directory: string;
let personalFilePath: string;
let sidecarFilePath: string;
let runtime: ReturnType<typeof createProviderRuntime> | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "acp-agent-sidecar-"));
  personalFilePath = join(directory, "provider_config.json");
  sidecarFilePath = resolveForkAcpAgentsFilePath(personalFilePath);
});
afterEach(async () => {
  runtime?.dispose();
  runtime = undefined;
  await rm(directory, { recursive: true, force: true });
});

/** `development` mirrors a development runtime (the dev-only ACP gate); `false` is a packaged host. */
function startRuntime(development = true) {
  runtime = createProviderRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath,
    watch: false,
    personalPollingIntervalMs: false,
    acpExecutable: development,
    acpAgentStore: new NodeForkAcpAgentStore({
      filePath: sidecarFilePath,
      pollingIntervalMs: false,
    }),
  });
  return runtime;
}

const SAVE = {
  agentId: "opencode",
  providerName: "opencode (ACP)",
  command: "/usr/local/bin/opencode",
  args: ["acp"],
  env: { OPENCODE_LOG: "1" },
  enabled: true,
} as const;

function acpProvider(view: ProviderSettingsView) {
  return view.providers.find((provider) => provider.providerId === "acp:opencode");
}

async function readMainFileText(): Promise<string> {
  try {
    return await readFile(personalFilePath, "utf8");
  } catch {
    return "";
  }
}

async function writeMainFile(providerRules: unknown[], modelRules: unknown[] = []) {
  await writeFile(
    personalFilePath,
    JSON.stringify(
      encodeProviderConfigFile({
        providers: parsePersonalProviderConfigMap({ providerRules }),
        models: parsePersonalModelConfigRules({
          providerModelRules: modelRules,
          manualProviderModelRules: [],
        }),
        providerOrder: [],
      }),
    ),
  );
}

describe("ACP agents stored in the fork sidecar", () => {
  it("enables, edits and disables an agent without touching provider_config.json", async () => {
    const service = startRuntime().providerSettings;
    const enabled = await service.saveAcpAgent(SAVE);
    expect(acpProvider(enabled)).toMatchObject({
      providerName: "opencode (ACP)",
      enabled: true,
      effectiveConfig: { access: { type: "acp-agent", command: "/usr/local/bin/opencode" } },
    });
    expect(acpProvider(enabled)?.models.map((model) => model.modelId)).toEqual(["opencode"]);

    const edited = await service.saveAcpAgent({ ...SAVE, command: "/opt/opencode", env: {} });
    expect(acpProvider(edited)?.effectiveConfig.access).toMatchObject({ command: "/opt/opencode" });

    const disabled = await service.setAcpAgentEnabled({ agentId: "opencode", enabled: false });
    expect(acpProvider(disabled)?.enabled).toBe(false);

    expect(await readMainFileText()).not.toContain("acp");
    expect(JSON.parse(await readFile(sidecarFilePath, "utf8"))).toEqual({
      schemaVersion: 1,
      agents: [{ ...SAVE, command: "/opt/opencode", env: {}, enabled: false }],
    });
  });

  it("rejects invalid launch configs and unknown agents before writing", async () => {
    const service = startRuntime().providerSettings;
    await expect(service.saveAcpAgent({ ...SAVE, command: "a\nb" })).rejects.toThrow(
      /Invalid ACP launch/,
    );
    await expect(
      service.saveAcpAgent({ ...SAVE, env: { NODE_OPTIONS: "--inspect" } }),
    ).rejects.toThrow(/Invalid ACP launch/);
    await expect(service.setAcpAgentEnabled({ agentId: "cursor", enabled: true })).rejects.toThrow(
      /Unknown ACP agent/,
    );
    await expect(readFile(sidecarFilePath, "utf8")).rejects.toThrow();
  });

  it("refuses an agent whose provider id is taken by a non-ACP provider", async () => {
    await writeMainFile([
      {
        providerId: "acp:opencode",
        providerName: "Someone else",
        config: { group: "standard-personal", access: { type: "api-key" } },
      },
    ]);
    const service = startRuntime().providerSettings;
    await expect(service.saveAcpAgent(SAVE)).rejects.toThrow(/already in use/);
    expect(acpProvider(await service.getView())?.effectiveConfig.access?.type).toBe("api-key");
  });

  it("migrates legacy inline ACP providers at start and keeps them resolvable", async () => {
    await writeMainFile(
      [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "acp-agent", agentId: "opencode", command: "opencode", args: ["acp"] },
            personalModelIds: ["opencode"],
          },
        },
      ],
      [
        {
          providerId: "acp:opencode",
          modelId: "opencode",
          config: buildAcpPseudoModelConfig("opencode"),
        },
      ],
    );
    const view = await startRuntime().providerSettings.getView();
    expect(acpProvider(view)?.effectiveConfig.access).toMatchObject({
      type: "acp-agent",
      command: "opencode",
    });
    expect(await readMainFileText()).not.toContain("acp");
    expect(JSON.parse(await readFile(sidecarFilePath, "utf8")).agents).toEqual([
      {
        agentId: "opencode",
        providerName: "opencode (ACP)",
        enabled: true,
        command: "opencode",
        args: ["acp"],
      },
    ]);
  });
});

describe("ACP agents outside a development runtime", () => {
  it("does not derive acp providers from the sidecar and refuses ACP writes", async () => {
    // A development host wrote the sidecar; a packaged host reads the same file.
    await startRuntime(true).providerSettings.saveAcpAgent(SAVE);
    const sidecarBefore = await readFile(sidecarFilePath, "utf8");

    const packaged = startRuntime(false).providerSettings;
    const view = await packaged.getView();
    expect(acpProvider(view)).toBeUndefined();

    await expect(packaged.saveAcpAgent(SAVE)).rejects.toThrow(/not supported/);
    await expect(
      packaged.setAcpAgentEnabled({ agentId: "opencode", enabled: false }),
    ).rejects.toThrow(/not supported/);
    expect(await readFile(sidecarFilePath, "utf8")).toBe(sidecarBefore);
  });
});
