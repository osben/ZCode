import { describe, expect, it } from "vitest";
import {
  FORK_RUST_AGENT_EXECUTION_WORKTREE_UNSUPPORTED,
  FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
  forkAgentRuntimeCommandGateError,
  forkAgentRuntimeHelloOverrides,
} from "../src/zcode-agent/fork-agent-runtime/contract.js";

const rust = { ZCODE_FORK_AGENT_RUNTIME: "rust" };
const node = { ZCODE_FORK_AGENT_RUNTIME: "node" };

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
  it("admits everything for the node runtime", () => {
    expect(
      forkAgentRuntimeCommandGateError(
        { type: "createSession", payload: { executionWorktree: { path: "/wt" } } },
        node,
      ),
    ).toBeUndefined();
  });

  it("refuses execution worktree commands for the rust runtime", () => {
    for (const envelope of [
      { type: "createSession", payload: { worktreePreparation: { branchName: "b" } } },
      { type: "createSession", payload: { executionWorktree: { path: "/wt" } } },
      { type: "updateWorktreePreparation", payload: {} },
    ]) {
      expect(forkAgentRuntimeCommandGateError(envelope, rust)).toBe(
        FORK_RUST_AGENT_EXECUTION_WORKTREE_UNSUPPORTED,
      );
    }
  });

  it("refuses ACP agent selections and config for the rust runtime", () => {
    const acp = { providerId: "acp:cursor", modelId: "default" };
    for (const envelope of [
      { type: "sendText", payload: { modelSelection: acp } },
      { type: "createSession", payload: { config: { modelSelection: acp } } },
      { type: "createSession", payload: { firstInput: { text: "hi", modelSelection: acp } } },
      { type: "setExternalAgentConfigOption", payload: {} },
      {
        type: "switchModelConfig",
        payload: { provider: "acp:cursor", model: "default", thought: "" },
      },
      { type: "createSession", payload: { config: { provider: "acp:cursor", model: "default" } } },
    ]) {
      expect(forkAgentRuntimeCommandGateError(envelope, rust)).toBe(
        FORK_RUST_AGENT_EXTERNAL_AGENT_UNSUPPORTED,
      );
    }
  });

  it("admits ordinary commands for the rust runtime", () => {
    expect(
      forkAgentRuntimeCommandGateError(
        { type: "switchModelConfig", payload: { provider: "zai", model: "glm", thought: "" } },
        rust,
      ),
    ).toBeUndefined();
    expect(
      forkAgentRuntimeCommandGateError(
        {
          type: "createSession",
          payload: { firstInput: { text: "hi", modelSelection: { providerId: "zai" } } },
        },
        rust,
      ),
    ).toBeUndefined();
    expect(forkAgentRuntimeCommandGateError({ type: "stop" }, rust)).toBeUndefined();
  });
});
