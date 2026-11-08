import { describe, expect, it } from "vitest";
import { selectForkAgentRuntimeCommand } from "../src/zcode-agent/fork-agent-runtime/contract.js";

const context = { workspacePath: "/work", workspaceKey: "/work" };
const nodeCommand = {
  command: "/electron",
  args: ["/bundle/zcode.cjs", "app-server", "--stdio"],
  storagePreparationEntry: "/bundle/zcode.cjs",
  cwd: "/work",
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

describe("selectForkAgentRuntimeCommand", () => {
  it("keeps the node command by default", () => {
    expect(selectForkAgentRuntimeCommand(nodeCommand, context, {})).toBe(nodeCommand);
    expect(
      selectForkAgentRuntimeCommand(nodeCommand, context, { ZCODE_FORK_AGENT_RUNTIME: "node" }),
    ).toBe(nodeCommand);
  });

  it("runs zcode-rs for the conversation and keeps node for storage preparation", () => {
    expect(
      selectForkAgentRuntimeCommand(nodeCommand, context, {
        ZCODE_FORK_AGENT_RUNTIME: "rust",
        ZCODE_FORK_RUST_AGENT_PATH: "/res/zcode-rs/zcode-rs",
      }),
    ).toEqual({
      command: "/res/zcode-rs/zcode-rs",
      args: ["app-server", "--stdio"],
      cwd: "/work",
      storagePreparationEntry: "/bundle/zcode.cjs",
    });
  });

  it("does not run rust without a binary path", () => {
    const missing: string[] = [];
    expect(
      selectForkAgentRuntimeCommand(
        nodeCommand,
        context,
        { ZCODE_FORK_AGENT_RUNTIME: "rust" },
        (r) => missing.push(r),
      ),
    ).toBe(nodeCommand);
    expect(missing).toEqual(["binary_path_missing"]);
  });

  it("does not run rust without a node storage entry", () => {
    const env = {
      ZCODE_FORK_AGENT_RUNTIME: "rust",
      ZCODE_FORK_RUST_AGENT_PATH: "/res/zcode-rs/zcode-rs",
    };
    const reasons: string[] = [];
    const report = (reason: string) => reasons.push(reason);
    expect(selectForkAgentRuntimeCommand(null, context, env, report)).toBeNull();
    const tsxSource = { command: "/tsx", args: ["main.ts"], cwd: "/work" };
    expect(selectForkAgentRuntimeCommand(tsxSource, context, env, report)).toBe(tsxSource);
    expect(reasons).toEqual(["no_node_bundle", "no_node_bundle"]);
  });
});
