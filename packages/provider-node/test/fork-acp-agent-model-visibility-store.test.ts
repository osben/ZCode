import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORK_ACP_AGENT_MODEL_VISIBILITY_FILE_NAME,
  NodeForkAcpAgentModelVisibilityStore,
  resolveForkAcpAgentModelVisibilityFilePath,
} from "../src/fork-acp-agent-store.js";

// specs/acp-agent-runtime.md "Settings: models and Advanced": the hidden set per agent, in a fork sidecar.
let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fork-acp-agent-model-visibility-"));
  filePath = resolveForkAcpAgentModelVisibilityFilePath(join(directory, "provider_config.json"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("NodeForkAcpAgentModelVisibilityStore", () => {
  it("lives next to the provider config under a fork_ file name", () => {
    expect(filePath).toBe(join(directory, FORK_ACP_AGENT_MODEL_VISIBILITY_FILE_NAME));
    expect(FORK_ACP_AGENT_MODEL_VISIBILITY_FILE_NAME.startsWith("fork_")).toBe(true);
  });

  it("reads nothing hidden before any write", async () => {
    const store = new NodeForkAcpAgentModelVisibilityStore({ filePath });
    expect(await store.readAgent("opencode")).toEqual([]);
  });

  it("stores a sorted, de-duplicated set per agent and keeps other agents", async () => {
    const store = new NodeForkAcpAgentModelVisibilityStore({ filePath });
    await store.write("opencode", ["b", "a", "b"]);
    await store.write("cursor", ["x"]);

    const reloaded = new NodeForkAcpAgentModelVisibilityStore({ filePath });
    expect(await reloaded.readAgent("opencode")).toEqual(["a", "b"]);
    expect(await reloaded.readAgent("cursor")).toEqual(["x"]);
  });

  it("removes the entry when nothing is hidden and skips equal writes", async () => {
    const store = new NodeForkAcpAgentModelVisibilityStore({ filePath });
    await store.write("opencode", ["a"]);
    const before = await readFile(filePath, "utf8");

    expect(await store.write("opencode", ["a"])).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe(before);

    expect(await store.write("opencode", [])).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, agents: [] });
  });

  it("reads an invalid file as empty, reports it once, and the next write replaces it", async () => {
    await writeFile(filePath, "{ not json");
    const onRecovery = vi.fn();
    const store = new NodeForkAcpAgentModelVisibilityStore({ filePath, onRecovery });

    expect(await store.readAgent("opencode")).toEqual([]);
    expect(await store.readAgent("opencode")).toEqual([]);
    expect(onRecovery).toHaveBeenCalledTimes(1);

    await store.write("opencode", ["a"]);
    expect(await store.readAgent("opencode")).toEqual(["a"]);
  });

  it("drops an invalid entry alone", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          { agentId: "bad id", hiddenModels: ["a"] },
          { agentId: "cursor", hiddenModels: ["x"] },
        ],
      }),
    );
    const store = new NodeForkAcpAgentModelVisibilityStore({ filePath });
    expect((await store.read()).agents).toEqual([{ agentId: "cursor", hiddenModels: ["x"] }]);
  });
});
