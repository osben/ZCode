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
      env: {
        ZCODE_FORK_NODE_HELPER_COMMAND: JSON.stringify({
          command: "/electron",
          args: ["/bundle/zcode.cjs", "__zcode-rust-helper", "--stdio"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        }),
      },
      storagePreparationEntry: "/bundle/zcode.cjs",
    });
  });

  it("hands the rust agent the bundled node entry as its helper command", () => {
    const selected = selectForkAgentRuntimeCommand(nodeCommand, context, {
      ZCODE_FORK_AGENT_RUNTIME: "rust",
      ZCODE_FORK_RUST_AGENT_PATH: "/res/zcode-rs/zcode-rs",
    });
    const helper = JSON.parse(selected?.env?.ZCODE_FORK_NODE_HELPER_COMMAND ?? "null") as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    // Same executable and entry as storage preparation: one plugin store, one migrated database.
    expect(helper.command).toBe(nodeCommand.command);
    expect(helper.args[0]).toBe(nodeCommand.storagePreparationEntry);
    // The helper must stay a plain Node process even though Electron is the executable.
    expect(helper.env.ELECTRON_RUN_AS_NODE).toBe("1");
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
