import { describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import { INCOGNITO_LOCKDOWN_PROFILE, type IncognitoProfile } from "@zcode/shared";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";

// apps/zcode-cli/docs/design/v2/incognito-session.md "Override points" owned by resolveAppRuntimeConfig.
const workingDirectory = "/workspace/app";
const userServer = { type: "stdio" as const, command: "npx", args: ["user-mcp"] };
const pluginServer = { type: "stdio" as const, command: "npx", args: ["plugin-mcp"] };
const loadedAgent = {
  name: "loaded-agent",
  description: "loaded",
  source: "user" as const,
  systemPrompt: "loaded prompt",
};
const inlineAgent = { ...loadedAgent, name: "inline-agent", source: "project" as const };

function resolve(incognito: IncognitoProfile | undefined) {
  return resolveAppRuntimeConfig({
    cliStorageRoot: "/tmp/zcode-cli",
    configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory }),
    options: {
      runtimeConfig: {
        modelSelection: { providerId: "test-provider", modelId: "test-model" },
        mcp: { enabled: true, servers: { user: userServer } },
        memory: { enabled: true },
        subagents: {
          profiles: [inlineAgent],
          builtInModelSelectionOverrides: {
            Explore: { providerId: "test-provider", modelId: "runtime-override-model" },
          },
        },
        ...(incognito ? { incognito } : {}),
      },
    },
    builtInSubagentModelSelectionOverrides: {
      "general-purpose": { providerId: "test-provider", modelId: "loaded-override-model" },
    },
    persistedOutputStyle: { name: "Concise", prompt: "Be brief." },
    persistedSystemPromptOverrides: { harness: "custom harness" },
    pluginMcpServers: { "plugin:x:y": pluginServer },
    pluginHooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hook" }] }],
    },
    subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
    subagentProfiles: [loadedAgent],
    workingDirectory,
  });
}

describe("resolveAppRuntimeConfig incognito overrides", () => {
  it("leaves a normal session untouched", () => {
    const { configuredMcpServers, runtimeConfig } = resolve(undefined);
    expect(Object.keys(configuredMcpServers).sort()).toEqual(["plugin:x:y", "user"]);
    expect(runtimeConfig.memory?.enabled).toBe(true);
    expect(runtimeConfig.hooks?.enabled).toBe(true);
    expect(runtimeConfig.outputStyle?.name).toBe("Concise");
    expect(runtimeConfig.systemPromptOverrides).toEqual({ harness: "custom harness" });
    expect(runtimeConfig.subagents?.profiles?.map((p) => p.name)).toEqual([
      "inline-agent",
      "loaded-agent",
    ]);
    expect(runtimeConfig.subagents?.builtInModelSelectionOverrides).toEqual({
      "general-purpose": { providerId: "test-provider", modelId: "loaded-override-model" },
      Explore: { providerId: "test-provider", modelId: "runtime-override-model" },
    });
    expect(runtimeConfig.incognito).toBeUndefined();
  });

  it("strips every config-owned capability for the lockdown profile", () => {
    const { configuredMcpServers, runtimeConfig } = resolve(INCOGNITO_LOCKDOWN_PROFILE);
    // Plugin servers follow the plugins toggle, which empties pluginMcpServers upstream of here.
    expect(Object.keys(configuredMcpServers)).toEqual(["plugin:x:y"]);
    expect(runtimeConfig.mcp?.enabled).toBe(true);
    expect(runtimeConfig.memory?.enabled).toBe(false);
    // Plugin hooks would otherwise force hooks.enabled back on (mergeRuntimeHooks).
    expect(runtimeConfig.hooks).toBeUndefined();
    expect(runtimeConfig.outputStyle).toBeUndefined();
    expect(runtimeConfig.systemPromptOverrides).toBeUndefined();
    expect(runtimeConfig.subagents?.profiles).toEqual([]);
    // Built-in agents stay available, but user-configured model overrides must not reach them.
    expect(runtimeConfig.subagents?.builtInModelSelectionOverrides).toEqual({});
    expect(runtimeConfig.incognito).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
  });

  it("keeps built-in model overrides when the session opted back into customAgents", () => {
    const { runtimeConfig } = resolve({ ...INCOGNITO_LOCKDOWN_PROFILE, customAgents: true });
    expect(runtimeConfig.subagents?.builtInModelSelectionOverrides).toEqual({
      "general-purpose": { providerId: "test-provider", modelId: "loaded-override-model" },
      Explore: { providerId: "test-provider", modelId: "runtime-override-model" },
    });
  });

  it("keeps a capability the session opted back into", () => {
    const { configuredMcpServers, runtimeConfig } = resolve({
      ...INCOGNITO_LOCKDOWN_PROFILE,
      mcp: true,
      memory: true,
      outputStyle: true,
    });
    expect(Object.keys(configuredMcpServers).sort()).toEqual(["plugin:x:y", "user"]);
    expect(runtimeConfig.memory?.enabled).toBe(true);
    expect(runtimeConfig.outputStyle?.name).toBe("Concise");
    expect(runtimeConfig.systemPromptOverrides).toBeUndefined();
  });
});
