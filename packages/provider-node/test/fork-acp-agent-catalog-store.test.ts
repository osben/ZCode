import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORK_ACP_AGENT_CATALOG_FILE_NAME,
  NodeForkAcpAgentCatalogStore,
  resolveForkAcpAgentCatalogFilePath,
} from "../src/fork-acp-agent-store.js";

// specs/acp-agent-runtime.md "S6 readiness": the per-agent catalog is a tolerant cache of the last offered options.
const MODE = {
  id: "mode",
  name: "Mode",
  description: null,
  category: "mode",
  currentValue: "build",
  options: [
    { value: "build", name: "Build", description: null, group: null },
    { value: "plan", name: "Plan", description: "Read only", group: "Modes" },
  ],
};

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fork-acp-agent-catalog-"));
  filePath = resolveForkAcpAgentCatalogFilePath(join(directory, "provider_config.json"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("NodeForkAcpAgentCatalogStore", () => {
  it("lives next to the provider config under a fork_ file name", () => {
    expect(filePath).toBe(join(directory, FORK_ACP_AGENT_CATALOG_FILE_NAME));
    expect(FORK_ACP_AGENT_CATALOG_FILE_NAME.startsWith("fork_")).toBe(true);
  });

  it("reads empty when no catalog was written and undefined for an unknown agent", async () => {
    const store = new NodeForkAcpAgentCatalogStore({ filePath });

    expect(await store.read()).toEqual({ agents: [] });
    expect(await store.readAgent("opencode")).toBeUndefined();
  });

  it("persists the offered options per agent and reads them back", async () => {
    const store = new NodeForkAcpAgentCatalogStore({ filePath });

    expect(await store.write("opencode", [MODE], 1_000)).toBe(true);

    const reloaded = new NodeForkAcpAgentCatalogStore({ filePath });
    expect(await reloaded.readAgent("opencode")).toEqual([MODE]);
    expect((await reloaded.read()).agents).toEqual([
      { agentId: "opencode", capturedAt: 1_000, options: [MODE] },
    ]);
  });

  it("keeps the other agents and replaces only the written one", async () => {
    const store = new NodeForkAcpAgentCatalogStore({ filePath });
    await store.write("opencode", [MODE]);
    await store.write("cursor", [{ ...MODE, currentValue: "plan" }]);

    await store.write("opencode", []);

    expect(await store.readAgent("opencode")).toEqual([]);
    expect(await store.readAgent("cursor")).toEqual([{ ...MODE, currentValue: "plan" }]);
  });

  it("does not rewrite the file when the offered options are equal", async () => {
    const store = new NodeForkAcpAgentCatalogStore({ filePath });
    await store.write("opencode", [MODE], 1_000);
    const before = await readFile(filePath, "utf8");

    expect(await store.write("opencode", [MODE], 2_000)).toBe(false);

    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("writes only the catalog fields, never extra keys of the input", async () => {
    const store = new NodeForkAcpAgentCatalogStore({ filePath });
    const withExtras = {
      ...MODE,
      env: { TOKEN: "secret" },
      options: MODE.options.map((value) => ({ ...value, extra: "x" })),
    } as unknown as typeof MODE;

    await store.write("opencode", [withExtras]);

    const text = await readFile(filePath, "utf8");
    expect(text).not.toContain("secret");
    expect(text).not.toContain('"extra"');
  });

  it("reads an invalid file as empty, reports it once, and drops only an invalid entry", async () => {
    const onRecovery = vi.fn();
    const store = new NodeForkAcpAgentCatalogStore({ filePath, onRecovery });
    await writeFile(filePath, "{not json", "utf8");

    expect(await store.read()).toEqual({ agents: [] });
    expect(await store.read()).toEqual({ agents: [] });
    expect(onRecovery).toHaveBeenCalledTimes(1);

    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          { agentId: "broken", capturedAt: 1, options: [{ id: 7 }] },
          { agentId: "opencode", capturedAt: 2, options: [MODE] },
        ],
      }),
      "utf8",
    );
    expect(await store.readAgent("broken")).toBeUndefined();
    expect(await store.readAgent("opencode")).toEqual([MODE]);
  });

  it("treats a file of another schema version as invalid, and a write replaces it", async () => {
    const onRecovery = vi.fn();
    const store = new NodeForkAcpAgentCatalogStore({ filePath, onRecovery });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, agents: [] }), "utf8");

    expect(await store.read()).toEqual({ agents: [] });
    expect(onRecovery).toHaveBeenCalledTimes(1);

    expect(await store.write("opencode", [MODE])).toBe(true);
    expect(await store.readAgent("opencode")).toEqual([MODE]);
  });
});
