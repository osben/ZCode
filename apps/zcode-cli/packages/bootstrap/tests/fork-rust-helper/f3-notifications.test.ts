// Fork: notifications in the helper (specs/fork-rust-node-helper.md F3). The MCP pool's notifications
// take Node's route (a subscribed panel's resource updates reach its session as pluginUi deltas), and a
// real server's tool list change also reaches the Rust side's pipes of it. A malformed notification
// from Rust is refused and logged, never run with a guessed value.
import type { McpConnectionPool } from "@zcode/adapters/mcp";
import type { McpPort, McpServerNotification, PluginLoadOutcome } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { ForkRustHelperMcpHost } from "../../src/fork-rust-helper/mcp-host.js";
import { ForkRustHelperServer } from "../../src/fork-rust-helper/server.js";
import type { ForkRustHelperClient } from "../../src/fork-rust-helper/rust-client.js";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";

const route = vi.hoisted(() => vi.fn());
vi.mock("../../src/zcode-protocol/mcp-ui/index.js", async (original) => ({
  ...(await original<typeof import("../../src/zcode-protocol/mcp-ui/index.js")>()),
  routeMcpServerNotification: route,
}));

const SERVER = "plugin:e2e-ui:app";

function rig() {
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const pool = {
    acquireLease: () =>
      ({
        connectServer: async () => ({ status: "connected" }) as never,
        close: async () => {},
      }) as Partial<McpPort> as McpPort,
  } as unknown as McpConnectionPool;
  const context = { sessions: new Map() } as unknown as ZCodeProtocolAgentServerContext;
  const host = new ForkRustHelperMcpHost({
    context,
    client: {} as ForkRustHelperClient,
    notify: (method, params) => notifications.push({ method, params }),
    pool,
    resolvePlugins: async () =>
      ({
        mcpServers: { [SERVER]: { type: "stdio", command: "server" } },
        plugins: [],
      }) as unknown as PluginLoadOutcome,
  });
  return { host, context, notifications };
}

describe("fork: Node helper MCP server notifications", () => {
  it("routes every notification as Node's server does", async () => {
    const { host, context, notifications } = rig();
    await host.connect({ connection: "c1", server: SERVER, workspace: { workspacePath: "/w" } });
    const updated: McpServerNotification = {
      kind: "resourceUpdated",
      serverName: SERVER,
      uri: "ui://doc/1",
      subscribers: ["key-1"],
    } as McpServerNotification;
    const listChanged = {
      kind: "resourceListChanged",
      serverName: SERVER,
      subscribers: ["key-1"],
    } as unknown as McpServerNotification;
    host.handleNotification(updated);
    host.handleNotification(listChanged);
    expect(route.mock.calls).toEqual([
      [context, updated],
      [context, listChanged],
    ]);
    // Resource notifications are not the pipes' business: the panels hear them through the session.
    expect(notifications).toEqual([]);
  });

  it("still sends a tool list change to the server's pipes", async () => {
    route.mockClear();
    const { host, context, notifications } = rig();
    await host.connect({ connection: "c1", server: SERVER, workspace: { workspacePath: "/w" } });
    await host.connect({ connection: "c2", server: "other", workspace: { workspacePath: "/w" } }).catch(() => {});
    const changed = { kind: "toolListChanged", serverName: SERVER } as McpServerNotification;
    host.handleNotification(changed);
    expect(route.mock.calls).toEqual([[context, changed]]);
    expect(notifications).toEqual([
      {
        method: "helper/mcp/message",
        params: {
          connection: "c1",
          message: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        },
      },
    ]);
  });
});

describe("fork: Node helper notifications from Rust", () => {
  it("refuses a pipe close without its connection", async () => {
    const closePipe = vi.fn(async () => {});
    const warn = vi.fn();
    const server = new ForkRustHelperServer({
      context: {} as ZCodeProtocolAgentServerContext,
      ensureSessionStore: async () => {},
      workflowRuns: {} as never,
      client: {} as ForkRustHelperClient,
      mcpHost: { closePipe } as unknown as ForkRustHelperMcpHost,
      logger: { warn } as never,
    });
    for (const params of [{}, { connection: 5 }, { connection: "" }])
      await server.handleMessage({ jsonrpc: "2.0", method: "helper/mcp/close", params } as never);
    expect(closePipe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      event: "fork_rust_helper.notification.refused",
      method: "helper/mcp/close",
    });
    await server.handleMessage({
      jsonrpc: "2.0",
      method: "helper/mcp/close",
      params: { connection: "c1" },
    } as never);
    expect(closePipe).toHaveBeenCalledWith("c1");
  });
});
