import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig, ModelConfigRules, ProviderConfig, ProviderConfigMap } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "../src/personal-provider-config-repository.js";
import { encodeProviderConfigFile } from "../src/provider-config-file-codec.js";
import { decodeWithUpstreamSchemas } from "./fixtures/upstream-3.16.1/upstream-decoder.js";

// specs/fork-provider-config-upstream-compat.md: reasoningLevel.default is fork-only and must never
// reach provider_config.json; upstream 3.16.1 rejects the whole file when it is present.

const LEVELS = ["low", "medium", "high"];
const MANUAL_LEAVES = {
  properties: {
    contextWindow: 1234,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
    inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
  },
  optionSpecs: { maxOutputTokens: { max: 128 } },
};

function manualConfig() {
  return ModelConfig.fromData({
    ...MANUAL_LEAVES,
    optionSpecs: {
      ...MANUAL_LEAVES.optionSpecs,
      reasoningLevel: { values: LEVELS, default: "high", map: "{}" },
    },
  });
}

function smartConfig() {
  return ModelConfig.fromData({
    optionSpecs: { reasoningLevel: { values: LEVELS, default: "medium", map: "{}" } },
  });
}

function providersWith(modelIds: readonly string[]) {
  return new ProviderConfigMap([
    ["p", new ProviderConfig({ personalModelIds: [...modelIds], modelOrder: [...modelIds] })],
  ]);
}

let directory: string;
const repositories: NodePersonalProviderConfigRepository[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fork-shared-file-compat-"));
});

afterEach(async () => {
  repositories.splice(0).forEach((repo) => repo.dispose());
  await rm(directory, { recursive: true, force: true });
});

function repository() {
  const repo = new NodePersonalProviderConfigRepository({
    filePath: join(directory, "provider_config.json"),
    pollingIntervalMs: false,
  });
  repositories.push(repo);
  return repo;
}

function filePath() {
  return join(directory, "provider_config.json");
}

describe("fork write paths never emit reasoningLevel.default into the shared file", () => {
  it("manual rule with an inherited default encodes to a file upstream accepts", () => {
    const models = ModelConfigRules.empty().setExact("p", "gpt-5.6", manualConfig(), false);

    const encoded = encodeProviderConfigFile({
      providers: providersWith(["gpt-5.6"]),
      models,
      providerOrder: ["p"],
    });

    expect(JSON.stringify(encoded)).not.toContain('"default"');
    expect(() => decodeWithUpstreamSchemas(encoded)).not.toThrow();
  });

  it("smart rule with a default encodes to a file upstream accepts", () => {
    const models = ModelConfigRules.empty().setExact("p", "smart", smartConfig(), true);

    const encoded = encodeProviderConfigFile({
      providers: providersWith(["smart"]),
      models,
      providerOrder: ["p"],
    });

    expect(JSON.stringify(encoded)).not.toContain('"default"');
    expect(() => decodeWithUpstreamSchemas(encoded)).not.toThrow();
  });

  it("the file written by NodePersonalProviderConfigRepository passes the upstream decoder", async () => {
    const repo = repository();

    await repo.update(() => ({
      providers: providersWith(["gpt-5.6", "smart"]),
      models: ModelConfigRules.empty()
        .setExact("p", "gpt-5.6", manualConfig(), false)
        .setExact("p", "smart", smartConfig(), true),
      providerOrder: ["p"],
    }));

    const raw = JSON.parse(await readFile(filePath(), "utf8"));
    expect(JSON.stringify(raw)).not.toContain('"default"');
    expect(() => decodeWithUpstreamSchemas(raw)).not.toThrow();
  });

  it("a file already holding the key is rewritten on read and stays stable afterwards", async () => {
    // Written by an earlier fork build: the manual rule carries reasoningLevel.default on disk.
    const stored = encodeProviderConfigFile({
      providers: providersWith(["gpt-5.6"]),
      models: ModelConfigRules.empty().setExact("p", "gpt-5.6", manualConfig(), false),
      providerOrder: ["p"],
    });
    const manual = stored.config.modelConfigRules.manualProviderModelRules[0]?.config;
    if (!manual?.optionSpecs?.reasoningLevel) throw new Error("fixture lost its reasoning leaf");
    manual.optionSpecs.reasoningLevel = { ...manual.optionSpecs.reasoningLevel, default: "high" };
    await writeFile(filePath(), JSON.stringify(stored, null, 2));
    expect(() => decodeWithUpstreamSchemas(stored)).toThrow();

    const repo = repository();
    const first = await repo.read();
    const afterFirstRead = await readFile(filePath(), "utf8");
    const second = await repo.read();

    expect(first.models.getExact("p", "gpt-5.6")?.toJSON().optionSpecs?.reasoningLevel).toEqual({
      values: LEVELS,
      map: "{}",
    });
    expect(second.revision).toBe(first.revision);
    expect(afterFirstRead).not.toContain('"default"');
    expect(await readFile(filePath(), "utf8")).toBe(afterFirstRead);
    expect(() => decodeWithUpstreamSchemas(JSON.parse(afterFirstRead))).not.toThrow();
  });
});
