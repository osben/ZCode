// Fork: helper session open and close (specs/fork-rust-node-helper.md F3, "Session open and close"):
// one session's opens and closes run in arrival order, a close names its open, a reopen replaces the
// open session, a failed open releases its lease, and an execution worktree session runs in its worktree.
// The MCP pool is a fake so each ordering is deterministic.
import type { McpConnectionPool } from "@zcode/adapters/mcp";
import type { McpPort, PluginLoadOutcome } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HelperWorkspace } from "../../src/fork-rust-helper/f3-protocol.js";
import { ForkRustHelperMcpHost } from "../../src/fork-rust-helper/mcp-host.js";
import type { ForkRustHelperClient } from "../../src/fork-rust-helper/rust-client.js";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";

const SERVER = "plugin:e2e-ui:app";
const SESSION = "sess_lane";
const PROJECT = "/home/ZCodeProject";
const WORKTREE = "/home/.zcode/worktrees/ZCodeProject/task-1";

interface FakeLease {
  leaseId: string;
  connected: { servers: Record<string, unknown>; options: Record<string, unknown> }[];
  calls: Record<string, unknown>[];
  closed: boolean;
}

function rig(options: { connect?: (lease: FakeLease) => Promise<void> } = {}) {
  const leases: FakeLease[] = [];
  const resolved: HelperWorkspace[] = [];
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const pool = {
    acquireLease: ({ leaseId }: { leaseId: string }) => {
      const lease: FakeLease = { leaseId, connected: [], calls: [], closed: false };
      leases.push(lease);
      const port: Partial<McpPort> = {
        connectServer: async () => ({ status: "connected" }) as never,
        connectConfiguredServers: async (servers, connectOptions) => {
          lease.connected.push({
            servers: servers as Record<string, unknown>,
            options: connectOptions as Record<string, unknown>,
          });
          await options.connect?.(lease);
          return { statuses: {}, tools: [] } as never;
        },
        callTool: async (request) => {
          lease.calls.push(request as unknown as Record<string, unknown>);
          return { content: [] } as never;
        },
        close: async () => {
          lease.closed = true;
        },
      };
      return port as McpPort;
    },
  } as unknown as McpConnectionPool;
  const context = { sessions: new Map() } as unknown as ZCodeProtocolAgentServerContext;
  const host = new ForkRustHelperMcpHost({
    context,
    client: {} as ForkRustHelperClient,
    notify: (method, params) => notifications.push({ method, params }),
    pool,
    resolvePlugins: async (workspace) => {
      resolved.push(workspace);
      return {
        mcpServers: { [SERVER]: { type: "stdio", command: "server" } },
        plugins: [],
      } as unknown as PluginLoadOutcome;
    },
  });
  const sessionLeases = () => leases.filter((lease) => lease.leaseId === SESSION);
  return { host, leases, sessionLeases, resolved, notifications, context };
}

const open = (openId: number, extra: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  openId,
  workspace: { workspacePath: PROJECT },
  pluginIds: [],
  servers: [SERVER],
  ...extra,
});

describe("fork: Node helper session open and close", () => {
  it("refuses an open without its openId", async () => {
    const { host } = rig();
    await expect(host.openSession({ ...open(1), openId: undefined })).rejects.toThrow(/openId/);
  });

  it("refuses an open whose executionDirectory is present but not a non-empty string", async () => {
    const { host, sessionLeases } = rig();
    for (const executionDirectory of ["", 5, null])
      await expect(host.openSession(open(1, { executionDirectory }))).rejects.toThrow(
        /executionDirectory/,
      );
    expect(sessionLeases()).toHaveLength(0);
    expect(host.busy).toBe(false);
  });

  it("refuses a malformed close and keeps the session open", async () => {
    const { host, sessionLeases } = rig();
    await host.openSession(open(1));
    await expect(host.closeSession({ sessionId: SESSION, openId: "1" })).rejects.toThrow(/openId/);
    await expect(host.closeSession({ sessionId: SESSION })).rejects.toThrow(/openId/);
    await expect(host.closeSession({ openId: 1 })).rejects.toThrow(/sessionId/);
    expect(sessionLeases()[0]?.closed).toBe(false);
    expect(host.busy).toBe(true);
  });

  it("resolves plugins once per workspace key and directory", async () => {
    const { host, resolved } = rig();
    await host.openSession(open(1, { workspace: { workspacePath: PROJECT, workspaceIdentity: " id " } }));
    await host.openSession(open(2, { workspace: { workspacePath: PROJECT, workspaceIdentity: "id" } }));
    await host.openSession({ ...open(3, { workspace: { workspacePath: PROJECT, workspaceIdentity: "" } }), sessionId: "s2" });
    await host.openSession({ ...open(4), sessionId: "s3" });
    expect(resolved).toHaveLength(2);
  });

  it("closes an open that was still in its lane when the host was disposed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { host, sessionLeases, context } = rig({ connect: () => gate });
    const opening = host.openSession(open(1));
    await vi.waitFor(() => expect(sessionLeases()).toHaveLength(1));
    const disposing = host.dispose();
    release();
    await expect(opening).rejects.toThrow(/disposed/);
    await disposing;
    expect(sessionLeases()[0]?.closed).toBe(true);
    expect(host.busy).toBe(false);
    expect(context.sessions.has(SESSION)).toBe(false);
  });

  it("replaces an open session with a reopen's params", async () => {
    const { host, sessionLeases } = rig();
    await host.openSession(open(1));
    await host.openSession(open(2, { servers: [] }));
    const [first, second] = sessionLeases();
    expect(first?.closed).toBe(true);
    expect(second?.closed).toBe(false);
    expect(second?.connected[0]?.servers).toEqual({});
    expect(host.busy).toBe(true);
  });

  it("ignores a close of an earlier open, and ends the session on its own open's close", async () => {
    const { host, sessionLeases } = rig();
    await host.openSession(open(1));
    await host.openSession(open(2));
    await host.closeSession({ sessionId: SESSION, openId: 1 });
    expect(sessionLeases()[1]?.closed).toBe(false);
    expect(host.busy).toBe(true);
    await host.closeSession({ sessionId: SESSION, openId: 2 });
    expect(sessionLeases()[1]?.closed).toBe(true);
    expect(host.busy).toBe(false);
  });

  it("runs a close and the reopen right after it in arrival order", async () => {
    const { host, sessionLeases } = rig();
    await host.openSession(open(1));
    const closing = host.closeSession({ sessionId: SESSION, openId: 1 });
    await host.openSession(open(2));
    await closing;
    const [first, second] = sessionLeases();
    expect(first?.closed).toBe(true);
    expect(second?.closed).toBe(false);
    expect(host.busy).toBe(true);
  });

  it("closes an open that its close overtook once the open finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { host, sessionLeases } = rig({ connect: () => gate });
    const opening = host.openSession(open(1));
    await vi.waitFor(() => expect(sessionLeases()).toHaveLength(1));
    const closing = host.closeSession({ sessionId: SESSION, openId: 1 });
    release();
    await opening;
    await closing;
    expect(sessionLeases()[0]?.closed).toBe(true);
    expect(host.busy).toBe(false);
  });

  it("releases the lease of an open whose connect throws", async () => {
    const { host, sessionLeases, context } = rig({
      connect: async () => {
        throw new Error("pool closed");
      },
    });
    await expect(host.openSession(open(1))).rejects.toThrow("pool closed");
    expect(sessionLeases()[0]?.closed).toBe(true);
    expect(host.busy).toBe(false);
    expect(context.sessions.has(SESSION)).toBe(false);
  });

  // Spec F3 "Session open and close", the pipe workspace limit: the key is stored, not yet enforced.
  it("stores each pipe's workspace key and still serves another workspace's session", async () => {
    const { host, sessionLeases, notifications } = rig();
    const DATA_ROOT = "/home/.zcode";
    await host.connect({
      connection: "c1",
      server: SERVER,
      workspace: { workspacePath: DATA_ROOT, workspaceIdentity: " data-root " },
    });
    await host.openSession(open(1));
    const pipes = (host as unknown as { pipes: Map<string, { workspaceKey?: string }> }).pipes;
    expect(pipes.get("c1")?.workspaceKey).toBe("data-root");
    await host.send({
      connection: "c1",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_doc",
          _meta: { "zcode/helperContext": { sessionId: SESSION, runtimeScope: "main" } },
        },
      },
    });
    expect(notifications.at(-1)?.params).toMatchObject({ message: { id: 1, result: {} } });
    expect(sessionLeases()[0]?.calls[0]).toMatchObject({ workspaceKey: PROJECT });
  });

  it("runs an execution worktree session in its worktree, under its workspace's key", async () => {
    const { host, sessionLeases, resolved, notifications } = rig();
    await host.openSession(open(1, { executionDirectory: WORKTREE }));
    // Node's app resolves plugins and connects its lease in the worktree (create-app.ts:200-230, :607-630).
    expect(resolved).toEqual([{ workspacePath: WORKTREE }]);
    expect(sessionLeases()[0]?.connected[0]?.options).toMatchObject({
      workingDirectory: WORKTREE,
      workspaceKey: PROJECT,
    });
    await host.connect({ connection: "c1", server: SERVER, workspace: { workspacePath: PROJECT } });
    await host.send({
      connection: "c1",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_doc",
          _meta: { "zcode/helperContext": { sessionId: SESSION, runtimeScope: "main" } },
        },
      },
    });
    expect(notifications.at(-1)?.params).toMatchObject({ message: { id: 1, result: {} } });
    // Node's MCP tool entry: workspacePath = the working directory, workspaceKey = the session's key
    // (core/src/mcp/index.ts:259-267).
    expect(sessionLeases()[0]?.calls[0]).toMatchObject({
      workspacePath: WORKTREE,
      workspaceKey: PROJECT,
    });
  });
});
