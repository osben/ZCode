import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { INCOGNITO_LOCKDOWN_PROFILE, type IncognitoProfile } from "@zcode/shared";
import * as outputStyle from "../src/output-style.js";
import * as systemPrompt from "../src/system-prompt.js";
import * as workspaceHookTrust from "../src/app/workspace-hook-trust.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

// apps/zcode-cli/docs/design/v2/incognito-session.md: createZCodeApp never loads an excluded
// capability's sources (Host agent profiles, persisted output style, prompt overrides, workspace
// hooks).
async function createApp(incognito: IncognitoProfile | undefined) {
  const root = await mkdtemp(join(tmpdir(), "zcode-incognito-app-"));
  const storage = join(root, "cli-storage");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(join(root, "config.json"), "{}");
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "true" }] }],
        },
      },
    }),
  );
  const readHost = vi.fn(async () => ({
    kind: "ready" as const,
    profiles: [],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  }));
  const app = await createRegistryBackedTestApp({
    env: {
      ZCODE_STORAGE_DIR: storage,
      ZCODE_SESSION_DB_PATH: join(storage, "cli", "db", "db.sqlite"),
    },
    userConfigPath: join(root, "config.json"),
    runtimeConfig: {
      workingDirectory: workspace,
      mcp: { enabled: false, servers: {} },
      modelSelection: { providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "low" } },
      ...(incognito ? { incognito } : {}),
    },
    readSubagentRuntimeConfig: readHost,
    workspaceHookTrustEnabled: true,
  });
  return {
    readHost,
    cleanup: async () => {
      await app.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("createZCodeApp incognito composition", () => {
  it.each([
    { label: "normal session", incognito: undefined, loads: true },
    { label: "lockdown profile", incognito: INCOGNITO_LOCKDOWN_PROFILE, loads: false },
  ])(
    "$label loads agent, output style, override and workspace hook sources: $loads",
    async (row) => {
      const styleLoader = vi.spyOn(outputStyle, "loadPersistedOutputStyle");
      const overrideLoader = vi.spyOn(systemPrompt, "loadPersistedSystemPromptOverrides");
      const hookSecurity = vi.spyOn(workspaceHookTrust, "createWorkspaceHookRuntimeSecurity");
      const { readHost, cleanup } = await createApp(row.incognito);
      try {
        expect(readHost).toHaveBeenCalledTimes(row.loads ? 1 : 0);
        expect(styleLoader).toHaveBeenCalledTimes(row.loads ? 1 : 0);
        expect(overrideLoader).toHaveBeenCalledTimes(row.loads ? 1 : 0);
        expect(hookSecurity.mock.calls[0]?.[0].snapshot !== undefined).toBe(row.loads);
      } finally {
        await cleanup();
        vi.restoreAllMocks();
      }
    },
  );
});
