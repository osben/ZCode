import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { afterEach, describe, expect, it } from "vitest";
import { startProcessProviderRegistryRuntime } from "../src/app/process-provider-registry-runtime.js";

// Worker-side derivation of ACP agent providers (specs/acp-agent-runtime.md "Chat delegation").
// The worker reads the fork sidecar next to provider_config.json; only the development runtime
// exposes the agent model to the chat Registry.

const ACP_PROVIDER_ID = "acp:opencode";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function workerEnv(runtimeEnv: "development" | "production") {
  const root = await mkdtemp(join(tmpdir(), "zcode-acp-worker-"));
  temporaryDirectories.push(root);
  const builtin = JSON.parse(
    await readFile(new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  const active = join(root, "active.json");
  const personal = join(root, "personal.json");
  await writeFile(active, JSON.stringify(builtin));
  await writeFile(
    join(root, "fork_acp_agents.json"),
    JSON.stringify({
      schemaVersion: 1,
      agents: [
        {
          agentId: "opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          command: "/usr/local/bin/opencode",
          args: ["acp"],
        },
      ],
    }),
  );
  return {
    // Data dir pinned to the temp root so the credential store never reads the user's real ~/.zcode.
    ZCODE_DATA_BASE_DIR: root,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: active,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personal,
    ZCODE_RUNTIME_ENV: runtimeEnv,
  };
}

// specs/acp-agent-runtime.md "Availability (platform rule)": derivation follows the platform predicate
// alone. The runtime env must change nothing, so both envs are checked on each platform.
const runtimeEnvs = ["development", "production"] as const;
describe("worker provider registry derives ACP agents", () => {
  for (const runtimeEnv of runtimeEnvs) {
    it(`exposes the agent model on a supported platform (${runtimeEnv} env)`, async () => {
      const runtime = await startProcessProviderRegistryRuntime(await workerEnv(runtimeEnv), {
        acpPlatform: "darwin",
      });
      try {
        const provider = runtime.snapshot.registry.providers.find(
          (entry) => entry.providerId === ACP_PROVIDER_ID,
        );
        expect(provider?.models.map((model) => model.modelId)).toEqual(["opencode"]);
        const records = await runtime.acpAgentStore.read();
        expect(records.agents.map((agent) => agent.agentId)).toEqual(["opencode"]);
      } finally {
        runtime.dispose();
      }
    });

    it(`keeps the agent out of the chat Registry on an unsupported platform (${runtimeEnv} env)`, async () => {
      const env = await workerEnv(runtimeEnv);
      const runtime = await startProcessProviderRegistryRuntime(env, { acpPlatform: "win32" });
      try {
        expect(
          runtime.snapshot.registry.providers.some((entry) => entry.providerId === ACP_PROVIDER_ID),
        ).toBe(false);
        // Availability hides the model; the sidecar record stays on disk untouched.
        const records = await runtime.acpAgentStore.read();
        expect(records.agents).toHaveLength(1);
      } finally {
        runtime.dispose();
      }
    });
  }

  it("does not write provider_config.json while deriving (the worker never migrates)", async () => {
    const env = await workerEnv("development");
    const runtime = await startProcessProviderRegistryRuntime(env);
    try {
      const personal = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV];
      await expect(readFile(personal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      runtime.dispose();
    }
  });
});
