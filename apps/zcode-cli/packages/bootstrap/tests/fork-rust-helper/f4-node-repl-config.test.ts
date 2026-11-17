// Fork F4a (specs/fork-rust-node-helper.md "F4 node_repl and browser", F4-D1): the helper computes node_repl's config
// from its own plugin resolution, with Node's injection rule.
import { describe, expect, it } from "vitest";
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import { withNodeReplServer } from "../../src/fork-rust-helper/node-repl.js";

const CUA_SOCKET = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";

function outcome(enabledIds: string[], withHost = true): PluginLoadOutcome {
  const ids = ["browser-use@zcode-plugins-official", "computer-use@zcode-plugins-official"];
  const plugins = ids.map((id) => ({
    id,
    enabled: enabledIds.includes(id),
    rootPath: `/plugins/${id.split("@")[0]}`,
  }));
  if (withHost)
    plugins.push({
      id: "node-repl-host@zcode-plugins-official",
      enabled: true,
      rootPath: "/plugins/node-repl-host",
    });
  return { plugins, mcpServers: { "plugin:other:files": { type: "stdio", command: "x", args: [] } } } as unknown as PluginLoadOutcome;
}

describe("helper node_repl config", () => {
  it("injects node_repl with Node's timeout when browser-use is enabled", () => {
    const result = withNodeReplServer(outcome(["browser-use@zcode-plugins-official"]), "/work");
    expect(result.mcpServers.node_repl).toMatchObject({ timeoutMs: 600_000, isolation: "workspace", protocolVersion: "2026-07-28" });
    expect(Object.keys(result.mcpServers)).toContain("plugin:other:files");
  });

  it("injects node_repl when only computer-use is enabled", () => {
    const result = withNodeReplServer(outcome(["computer-use@zcode-plugins-official"]), "/work");
    expect(result.mcpServers.node_repl).toBeDefined();
  });

  it("does not inject node_repl when neither capability is enabled", () => {
    const result = withNodeReplServer(outcome([]), "/work");
    expect(result.mcpServers.node_repl).toBeUndefined();
  });

  it("does not inject node_repl without the node-repl-host plugin", () => {
    const result = withNodeReplServer(outcome(["browser-use@zcode-plugins-official"], false), "/work");
    expect(result.mcpServers.node_repl).toBeUndefined();
  });

  // F4c (F4-D6): the computer-use broker socket reaches node_repl only, from the helper's own env.
  it("passes the computer-use broker socket to node_repl only", () => {
    const result = withNodeReplServer(
      outcome(["computer-use@zcode-plugins-official"]),
      "/work",
      { [CUA_SOCKET]: "/tmp/cua.sock" },
    );
    expect(result.mcpServers.node_repl?.env).toMatchObject({ [CUA_SOCKET]: "/tmp/cua.sock" });
    expect(result.mcpServers["plugin:other:files"]).toEqual({ type: "stdio", command: "x", args: [] });
  });

  // The CLI entry strips the socket from process.env before the helper runs, and node_repl's own plugin-host
  // child only restores it when Node's trusted markers are present. Both must be set with the socket.
  it("sets Node's trusted markers with the broker socket, as Node's injection does", () => {
    const result = withNodeReplServer(
      outcome(["computer-use@zcode-plugins-official"]),
      "/work",
      { [CUA_SOCKET]: "/tmp/cua.sock" },
    );
    expect(result.mcpServers.node_repl?.env).toMatchObject({
      [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
      [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    });
  });

  it("does not set the broker socket when the helper env has none or a blank one", () => {
    const none = withNodeReplServer(outcome(["browser-use@zcode-plugins-official"]), "/work", {});
    expect(none.mcpServers.node_repl?.env?.[CUA_SOCKET]).toBeUndefined();
    const blank = withNodeReplServer(outcome(["browser-use@zcode-plugins-official"]), "/work", {
      [CUA_SOCKET]: "   ",
    });
    expect(blank.mcpServers.node_repl?.env?.[CUA_SOCKET]).toBeUndefined();
  });
});
