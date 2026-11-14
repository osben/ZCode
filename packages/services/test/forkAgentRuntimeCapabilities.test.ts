import { describe, expect, it } from "vitest";
import {
  FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
  forkAgentRuntimeCommandGateError,
  forkAgentRuntimeHelloOverrides,
} from "../src/zcode-agent/fork-agent-runtime/contract.js";

const rust = { ZCODE_FORK_AGENT_RUNTIME: "rust" };
const node = { ZCODE_FORK_AGENT_RUNTIME: "node" };
const withAcp = { externalAgentTurns: async () => true };
const withoutAcp = { externalAgentTurns: async () => false };
const unread = {
  externalAgentTurns: async (): Promise<boolean> => {
    throw new Error("the capability must not be read");
  },
};

const acp = { providerId: "acp:cursor", modelId: "default" };
const acpCommands = [
  { type: "sendText", payload: { modelSelection: acp } },
  { type: "createSession", payload: { config: { modelSelection: acp } } },
  { type: "createSession", payload: { firstInput: { text: "hi", modelSelection: acp } } },
  { type: "setExternalAgentConfigOption", payload: {} },
  {
    type: "switchModelConfig",
    payload: { provider: "acp:cursor", model: "default", thought: "" },
  },
  { type: "createSession", payload: { config: { provider: "acp:cursor", model: "default" } } },
];

describe("forkAgentRuntimeHelloOverrides", () => {
  it("changes nothing for the node runtime", () => {
    expect(forkAgentRuntimeHelloOverrides(node)).toEqual({});
    expect(forkAgentRuntimeHelloOverrides({})).toEqual({});
  });

  it("keeps the incognito capabilities now that zcode-rs implements them", () => {
    expect(forkAgentRuntimeHelloOverrides(rust)).toEqual({});
  });
});

describe("forkAgentRuntimeCommandGateError", () => {
  it("admits everything for the node runtime without reading the capability", async () => {
    for (const envelope of [
      { type: "createSession", payload: { executionWorktree: { path: "/wt" } } },
      ...acpCommands,
    ]) {
      expect(await forkAgentRuntimeCommandGateError(envelope, unread, node)).toBeUndefined();
    }
  });

  it("admits execution worktree commands for the rust runtime", async () => {
    for (const envelope of [
      { type: "createSession", payload: { worktreePreparation: { branchName: "b" } } },
      { type: "createSession", payload: { executionWorktree: { path: "/wt" } } },
      { type: "updateWorktreePreparation", payload: {} },
    ]) {
      expect(await forkAgentRuntimeCommandGateError(envelope, unread, rust)).toBeUndefined();
    }
  });

  it("refuses ACP agent selections and config for a rust runtime without externalAgentTurns", async () => {
    for (const envelope of acpCommands) {
      expect(await forkAgentRuntimeCommandGateError(envelope, withoutAcp, rust)).toBe(
        FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
      );
    }
  });

  it("refuses ACP commands when the capability read fails", async () => {
    const failing = {
      externalAgentTurns: async (): Promise<boolean> => {
        throw new Error("read failed");
      },
    };
    expect(await forkAgentRuntimeCommandGateError(acpCommands[0]!, failing, rust)).toBe(
      FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
    );
  });

  it("admits ACP agent selections and config for a rust runtime that reports externalAgentTurns", async () => {
    for (const envelope of acpCommands) {
      expect(await forkAgentRuntimeCommandGateError(envelope, withAcp, rust)).toBeUndefined();
    }
  });

  it("admits ordinary commands for the rust runtime without reading the capability", async () => {
    for (const envelope of [
      { type: "switchModelConfig", payload: { provider: "zai", model: "glm", thought: "" } },
      {
        type: "createSession",
        payload: { firstInput: { text: "hi", modelSelection: { providerId: "zai" } } },
      },
      { type: "stop" },
      // Not ACP for the runtimes either: Node (`v4-bridge.ts`, `providerId.startsWith(ACP_PROVIDER_ID_PREFIX)`) and
      // zcode-rs (`ModelSelection::external_agent`) match the prefix without trimming.
      { type: "sendText", payload: { modelSelection: { providerId: " acp:cursor" } } },
    ]) {
      expect(await forkAgentRuntimeCommandGateError(envelope, unread, rust)).toBeUndefined();
    }
  });
});
