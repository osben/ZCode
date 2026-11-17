// Fork F4a (specs/fork-rust-node-helper.md "F4 node_repl and browser", F4-D1): the helper computes node_repl's config
// from its own plugin resolution, with Node's injection rule.
import { describe, expect, it } from "vitest";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { withNodeReplServer } from "../../src/fork-rust-helper/node-repl.js";

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
});
