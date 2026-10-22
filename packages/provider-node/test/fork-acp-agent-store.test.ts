import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAcpPseudoModelConfig,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  type ForkAcpAgentRecord,
} from "@zcode/provider";
import {
  FORK_ACP_AGENTS_FILE_NAME,
  NodeForkAcpAgentStore,
  migrateInlineAcpProviders,
  resolveForkAcpAgentsFilePath,
} from "../src/fork-acp-agent-store.js";
import { NodePersonalProviderConfigRepository } from "../src/personal-provider-config-repository.js";
import { encodeProviderConfigFile } from "../src/provider-config-file-codec.js";
import { decodeWithUpstreamSchemas } from "./fixtures/upstream-3.16.1/upstream-decoder.js";

const OPENCODE: ForkAcpAgentRecord = {
  agentId: "opencode",
  providerName: "opencode (ACP)",
  enabled: true,
  command: "/usr/local/bin/opencode",
  args: ["acp"],
};

let directory: string;
let personalFilePath: string;
let sidecarFilePath: string;
const disposables: Array<{ dispose(): void }> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fork-acp-agent-store-"));
  personalFilePath = join(directory, "provider_config.json");
  sidecarFilePath = resolveForkAcpAgentsFilePath(personalFilePath);
});
afterEach(async () => {
  disposables.splice(0).forEach((item) => item.dispose());
  await rm(directory, { recursive: true, force: true });
});

function store(onRecovery?: (error: unknown) => void) {
  const created = new NodeForkAcpAgentStore({
    filePath: sidecarFilePath,
    pollingIntervalMs: false,
    ...(onRecovery ? { onRecovery } : {}),
  });
  disposables.push(created);
  return created;
}

function repository() {
  const created = new NodePersonalProviderConfigRepository({
    filePath: personalFilePath,
    pollingIntervalMs: false,
  });
  disposables.push(created);
  return created;
}

/** A provider_config.json as the pre-sidecar fork build wrote it (inline acp-agent provider). */
async function writeLegacyInlineFile(command = "opencode") {
  const file = encodeProviderConfigFile({
    providers: parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "acp:opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "acp-agent", agentId: "opencode", command, args: ["acp"] },
            personalModelIds: ["opencode"],
            modelOrder: ["opencode"],
          },
        },
        {
          providerId: "custom-1",
          providerName: "Mine",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "test-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
            personalModelIds: ["m"],
          },
        },
      ],
    }),
    models: parsePersonalModelConfigRules({
      providerModelRules: [
        {
          providerId: "acp:opencode",
          modelId: "opencode",
          config: buildAcpPseudoModelConfig("opencode"),
        },
      ],
      manualProviderModelRules: [],
    }),
    providerOrder: ["custom-1", "acp:opencode"],
  });
  await writeFile(personalFilePath, JSON.stringify(file, null, 2));
}

describe("NodeForkAcpAgentStore", () => {
  it("lives next to provider_config.json under a fork_ name", () => {
    expect(FORK_ACP_AGENTS_FILE_NAME.startsWith("fork_")).toBe(true);
    expect(sidecarFilePath).toBe(join(directory, FORK_ACP_AGENTS_FILE_NAME));
  });

  it("reads empty without a file and persists updates with a stable revision", async () => {
    const acp = store();
    const listener = vi.fn();
    acp.onDidChange(listener);
    expect((await acp.read()).agents).toEqual([]);
    const written = await acp.update(() => [OPENCODE]);
    expect(written.agents).toEqual([OPENCODE]);
    expect(listener).toHaveBeenCalledWith("updated");
    expect(JSON.parse(await readFile(sidecarFilePath, "utf8"))).toEqual({
      schemaVersion: 1,
      agents: [OPENCODE],
    });
    const reread = await store().read();
    expect(reread.revision).toBe(written.revision);
  });

  it("preserves an invalid sidecar, reads it as empty and refuses to overwrite it", async () => {
    await writeFile(sidecarFilePath, "{ not json");
    const onRecovery = vi.fn();
    const acp = store(onRecovery);
    expect((await acp.read()).agents).toEqual([]);
    expect(onRecovery).toHaveBeenCalledTimes(1);
    await expect(acp.update(() => [OPENCODE])).rejects.toThrow();
    expect(await readFile(sidecarFilePath, "utf8")).toBe("{ not json");
  });

  it("rejects duplicate agent ids", async () => {
    await expect(store().update(() => [OPENCODE, OPENCODE])).rejects.toThrow(/Duplicate/);
  });
});

describe("migrateInlineAcpProviders", () => {
  it("moves inline acp-agent providers out and leaves an upstream-decodable file", async () => {
    await writeLegacyInlineFile();
    // The legacy file is exactly what upstream rejects.
    const legacy: unknown = JSON.parse(await readFile(personalFilePath, "utf8"));
    expect(() => decodeWithUpstreamSchemas(legacy)).toThrow();

    const result = await migrateInlineAcpProviders(repository(), store());
    expect(result).toEqual({ copied: ["opencode"], stripped: true, kept: [], conflicts: [] });

    const mainText = await readFile(personalFilePath, "utf8");
    expect(mainText).not.toContain("acp:");
    expect(mainText).not.toContain("acp-agent");
    expect(() => decodeWithUpstreamSchemas(JSON.parse(mainText))).not.toThrow();
    const main = JSON.parse(mainText);
    expect(main.config.providerOrder).toEqual(["custom-1"]);
    expect(
      main.config.providerConfigRules.providerRules.map(
        (rule: { providerId: string }) => rule.providerId,
      ),
    ).toEqual(["custom-1"]);

    expect((await store().read()).agents).toEqual([{ ...OPENCODE, command: "opencode" }]);
  });

  it("is idempotent", async () => {
    await writeLegacyInlineFile();
    await migrateInlineAcpProviders(repository(), store());
    const mainBefore = await readFile(personalFilePath, "utf8");
    const sidecarBefore = await readFile(sidecarFilePath, "utf8");
    expect(await migrateInlineAcpProviders(repository(), store())).toEqual({
      copied: [],
      stripped: false,
      kept: [],
      conflicts: [],
    });
    expect(await readFile(personalFilePath, "utf8")).toBe(mainBefore);
    expect(await readFile(sidecarFilePath, "utf8")).toBe(sidecarBefore);
  });

  it("strips an inline rule that is identical to its sidecar record", async () => {
    // State after a crash between the sidecar write and the strip: both copies are the same record.
    await writeLegacyInlineFile("/usr/local/bin/opencode");
    await store().update(() => [OPENCODE]);

    const result = await migrateInlineAcpProviders(repository(), store());
    expect(result).toEqual({ copied: [], stripped: true, kept: [], conflicts: [] });
    expect((await store().read()).agents).toEqual([OPENCODE]);
    expect(await readFile(personalFilePath, "utf8")).not.toContain("acp:");
  });

  it("keeps a differing inline rule in provider_config.json and reports it (sidecar wins on read)", async () => {
    // A newer sidecar edit made the inline rule stale; the inline copy is not user-visible data we may drop.
    await writeLegacyInlineFile("old-command");
    await store().update(() => [OPENCODE]);
    const sidecarBefore = await readFile(sidecarFilePath, "utf8");

    const result = await migrateInlineAcpProviders(repository(), store());
    expect(result.stripped).toBe(false);
    expect(result.copied).toEqual([]);
    expect(result.conflicts).toEqual(["opencode"]);
    expect(result.kept).toHaveLength(1);
    expect(await readFile(personalFilePath, "utf8")).toContain("acp:");
    expect(await readFile(sidecarFilePath, "utf8")).toBe(sidecarBefore);
    expect((await store().read()).agents).toEqual([OPENCODE]);
  });

  it("does nothing for a file without inline ACP providers", async () => {
    expect(await migrateInlineAcpProviders(repository(), store())).toEqual({
      copied: [],
      stripped: false,
      kept: [],
      conflicts: [],
    });
  });

  it("never strips an acp-agent rule it could not copy", async () => {
    const access = (command: string) => ({
      type: "acp-agent",
      agentId: "x",
      command,
      args: [],
    });
    await writeFile(
      personalFilePath,
      JSON.stringify(
        encodeProviderConfigFile({
          providers: parsePersonalProviderConfigMap({
            providerRules: [
              // Not an acp:<agentId> id, so it has no sidecar record shape.
              {
                providerId: "custom-acp",
                config: { group: "standard-personal", access: access("custom") },
              },
              // An acp: id that is not a valid agent id (whitespace) fails record parsing.
              {
                providerId: "acp:bad id",
                config: { group: "standard-personal", access: access("bad") },
              },
            ],
          }),
          models: parsePersonalModelConfigRules({
            providerModelRules: [],
            manualProviderModelRules: [],
          }),
          providerOrder: [],
        }),
      ),
    );
    const before = await readFile(personalFilePath, "utf8");
    expect(await migrateInlineAcpProviders(repository(), store())).toEqual({
      copied: [],
      stripped: false,
      kept: ["custom-acp", "acp:bad id"],
      conflicts: [],
    });
    expect(await readFile(personalFilePath, "utf8")).toBe(before);
    expect((await store().read()).agents).toEqual([]);
  });
});

describe("NodeForkAcpAgentStore recovery reporting", () => {
  it("reports an invalid sidecar once per file content, not on every read", async () => {
    await writeFile(sidecarFilePath, "{ not json");
    const onRecovery = vi.fn();
    const recovering = new NodeForkAcpAgentStore({
      filePath: sidecarFilePath,
      pollingIntervalMs: false,
      onRecovery,
    });
    try {
      await recovering.read();
      await recovering.read();
      await recovering.read();
      expect(onRecovery).toHaveBeenCalledTimes(1);

      // A different invalid revision is a new report.
      await writeFile(sidecarFilePath, '{"schemaVersion": 1, "agents": 7}');
      await recovering.read();
      expect(onRecovery).toHaveBeenCalledTimes(2);
    } finally {
      recovering.dispose();
    }
  });
});
