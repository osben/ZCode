// Fork: F3 of the Rust agent's Node helper (specs/fork-rust-node-helper.md, "F3 Office tools and
// panels"): the MCP pipe facade, helper sessions, mention items through the Rust authorization round
// trip, and the session's frozen reference catalog. The plugin is an inline MCP App plugin served
// by a raw stdio MCP server, the same kind as the desktop E2E fixtures.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORK_RUST_HELPER_METHODS,
  FORK_RUST_HELPER_PROTOCOL_VERSION,
  runForkRustHelper,
} from "../../src/fork-rust-helper/contract.js";
import { ForkRustHelperClient } from "../../src/fork-rust-helper/rust-client.js";

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

const PLUGIN = "e2e-ui";
const PLUGIN_ID = `${PLUGIN}@inline`;
const SERVER = `plugin:${PLUGIN}:app`;
const SESSION = "sess_f3_main";

// A raw stdio MCP server: `open_doc` (model and app), `app_only` (app), `slow` (never answers),
// `mention_search` (app, composer.mention items). `open_doc` echoes the request-context session.
const SERVER_SOURCE = String.raw`
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const tool = (name, visibility, extra = {}) => ({
  name,
  description: name + " tool",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  _meta: { ui: { visibility } },
  ...extra,
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion,
      capabilities: { tools: {}, resources: {} }, serverInfo: { name: "f3", version: "1.0.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [
      tool("open_doc", ["model", "app"], { annotations: { readOnlyHint: true } }),
      tool("slow", ["model", "app"]),
      tool("app_only", ["app"]),
      tool("mention_search", ["app"]),
    ] } });
  } else if (method === "tools/call") {
    if (params.name === "slow") return;
    if (params.name === "mention_search") {
      const q = String(params.arguments?.query ?? "");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: q }],
        structuredContent: { items: [{ id: q + "-1", label: "Doc " + q, insertText: "DOC[" + q + "]" }] } } });
      return;
    }
    const context = params._meta?.["com.zcode/request-context"] ?? {};
    if (params.arguments?.query === "cwd") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: process.cwd() }] } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text",
      text: "called " + params.name + " for " + (context.session_id ?? "none") }] } });
  } else if (method === "resources/list") {
    send({ jsonrpc: "2.0", id, result: { resources: [] } });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
`;

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  // MCP server processes may still flush files right after the helper stopped.
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fork-rust-helper-f3-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const storageDir = join(home, ".zcode");
  const workspace = join(dir, "project");
  const pluginDir = join(dir, "plugins", PLUGIN);
  await mkdir(workspace, { recursive: true });
  await mkdir(join(pluginDir, ".zcode-plugin"), { recursive: true });
  await writeFile(join(pluginDir, "server.mjs"), SERVER_SOURCE);
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(pluginDir, ".zcode-plugin", "plugin.json"),
    JSON.stringify({
      name: PLUGIN,
      version: "1.0.0",
      mcpServers: {
        app: { type: "stdio", command: process.execPath, args: ["${ZCODE_PLUGIN_ROOT}/server.mjs"] },
      },
      ui: {
        surfaces: [
          {
            id: "panel",
            title: "Panel",
            server: "app",
            resourceUri: `ui://${PLUGIN}/panel.html`,
            availability: "session",
          },
        ],
      },
      slots: {
        "composer.mention": [{ id: "docs", title: "Docs", target: { tool: "mention_search" } }],
      },
    }),
  );
  await mkdir(join(storageDir, "cli"), { recursive: true });
  await writeFile(
    join(storageDir, "cli", "config.json"),
    JSON.stringify({
      plugins: { enabled: true, dirs: [pluginDir], enabledPlugins: { [PLUGIN_ID]: true } },
    }),
  );
  vi.stubEnv("HOME", home);
  return {
    workspace,
    env: {
      ...process.env,
      HOME: home,
      ZCODE_STORAGE_DIR: storageDir,
      ZCODE_SESSION_DB_PATH: join(storageDir, "cli", "db", "db.sqlite"),
    },
  };
}

type ReverseHandler = (params: Record<string, unknown>) => Promise<Frame> | Frame;

/** Drives the helper over stdio as the Rust agent does, answering the helper's own requests. */
function startHelper(env: NodeJS.ProcessEnv, cwd: string, reverse: Record<string, ReverseHandler> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<string, (frame: Frame) => void>();
  const notifications: Frame[] = [];
  const reverseRequests: Frame[] = [];
  const write = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: output }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (frame.method && frame.id !== undefined) {
      reverseRequests.push(frame);
      const handler = reverse[frame.method];
      void Promise.resolve(
        handler ? handler(frame.params ?? {}) : { error: { code: -32601, message: "no handler" } },
      ).then((answer) => write({ id: frame.id, ...answer }));
    } else if (frame.id !== undefined && pending.has(String(frame.id))) {
      pending.get(String(frame.id))!(frame);
      pending.delete(String(frame.id));
    } else if (frame.method) notifications.push(frame);
  });
  const done = runForkRustHelper({ input, output, env, cwd });
  let next = 0;
  let opens = 0;
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  const helper = {
    notifications,
    reverseRequests,
    done,
    workspace,
    request(method: string, params: unknown): Promise<Frame> {
      next += 1;
      const id = `rs-${next}`;
      const reply = new Promise<Frame>((resolve) => pending.set(id, resolve));
      write({ id, method, params });
      return reply;
    },
    notify(method: string, params: unknown) {
      write({ method, params });
    },
    /** Sends one MCP message over a pipe connection and waits for the facade's answer to it. */
    async mcp(connection: string, message: { id?: number; method: string; params?: unknown }) {
      helper.notify("helper/mcp/send", { connection, message: { jsonrpc: "2.0", ...message } });
      if (message.id === undefined) return undefined;
      let found: Record<string, unknown> | undefined;
      await vi.waitFor(
        () => {
          found = notifications
            .filter((frame) => frame.method === "helper/mcp/message")
            .map((frame) => frame.params as { connection: string; message: Record<string, unknown> })
            .find((params) => params.connection === connection && params.message.id === message.id)
            ?.message;
          expect(found).toBeDefined();
        },
        { timeout: 15_000 },
      );
      return found!;
    },
    openSession(sessionId = SESSION, pluginIds = [PLUGIN_ID]) {
      opens += 1;
      return helper.request("helper/session/open", {
        sessionId,
        openId: opens,
        workspace,
        pluginIds,
        servers: [SERVER],
      });
    },
    close() {
      input.end();
    },
  };
  return helper;
}

async function initialized(env: NodeJS.ProcessEnv, cwd: string, reverse?: Record<string, ReverseHandler>) {
  const helper = startHelper(env, cwd, reverse);
  const reply = await helper.request("helper/initialize", {
    protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
  });
  expect(reply.error).toBeUndefined();
  return helper;
}

describe("fork: Node helper F3 (Office tools and panels)", () => {
  it("advertises the session-scoped MCP App methods", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    for (const method of [
      "mcp/readResource",
      "mcp/uiOpenInstance",
      "mcp/uiCallTool",
      "mcp/uiSampling",
      "mcp/uiRegisterAppTools",
      "mcp/uiResolveAppToolCall",
      "plugins/mentionItems",
    ])
      expect(FORK_RUST_HELPER_METHODS).toContain(method);
    expect(FORK_RUST_HELPER_METHODS.filter((method) => method.startsWith("mcp/ui"))).toHaveLength(16);
    helper.close();
    await helper.done;
  });

  it("answers helper/ping, the liveness check of Rust's timeout rule", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    const reply = await helper.request("helper/ping", {});
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({});
    helper.close();
    await helper.done;
  });

  it("serves a helper-hosted server to Rust's MCP client over the pipe", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    const connected = await helper.request("helper/mcp/connect", {
      connection: "c1",
      server: SERVER,
      workspace: helper.workspace,
    });
    expect(connected.error).toBeUndefined();

    const init = await helper.mcp("c1", {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rs" } },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
    });
    // A notification is never answered.
    await helper.mcp("c1", { method: "notifications/initialized" });

    const listed = (await helper.mcp("c1", { id: 2, method: "tools/list", params: {} })) as {
      result: { tools: { name: string; annotations?: unknown }[]; nextCursor?: string };
    };
    expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual(["open_doc", "slow"]);
    expect(listed.result.tools.find((tool) => tool.name === "open_doc")?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(listed.result.nextCursor).toBeUndefined();

    expect((await helper.openSession()).error).toBeUndefined();
    const called = await helper.mcp("c1", {
      id: 3,
      method: "tools/call",
      params: {
        name: "open_doc",
        arguments: { query: "a" },
        _meta: {
          "zcode/toolUseId": "toolu_1",
          "zcode/helperContext": { sessionId: SESSION, turnId: "turn_1", runtimeScope: "main" },
        },
      },
    });
    expect(called.result).toEqual({
      content: [{ type: "text", text: `called open_doc for ${SESSION}` }],
    });

    const pinged = await helper.mcp("c1", { id: 4, method: "ping" });
    expect(pinged.result).toEqual({});
    const unknown = (await helper.mcp("c1", { id: 5, method: "prompts/list" })) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
    // Each pipe message is relayed with no notification noise other than the facade's answers.
    expect(
      helper.notifications.filter(
        (frame) =>
          frame.method === "helper/mcp/message" &&
          (frame.params as { message: { id?: unknown } }).message.id === undefined,
      ),
    ).toEqual([]);
    helper.close();
    await helper.done;
  }, 60_000);

  // The Host's shared local task runtime is one Rust agent for every local workspace, run in the data root: its
  // pipes name `<home>/.zcode` while its sessions live in their own workspaces (spec F3 "Session open and close").
  for (const order of ["pipe first", "session first"] as const)
    it(`keeps each pipe's and each session's own workspace (${order})`, async () => {
      const home = await tempHome();
      const agentCwd = home.env.ZCODE_STORAGE_DIR!;
      const helper = await initialized(home.env, agentCwd);
      const connectPipe = () =>
        helper.request("helper/mcp/connect", {
          connection: "c1",
          server: SERVER,
          workspace: { workspacePath: agentCwd },
        });
      const openSession = () =>
        helper.request("helper/session/open", {
          sessionId: SESSION,
          openId: 1,
          workspace: { workspacePath: home.workspace },
          pluginIds: [PLUGIN_ID],
          servers: [SERVER],
        });
      const [first, second] =
        order === "pipe first" ? [connectPipe, openSession] : [openSession, connectPipe];
      expect((await first()).error).toBeUndefined();
      expect((await second()).error).toBeUndefined();
      await helper.mcp("c1", {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rs" } },
      });
      // A model tool call runs on the session's lease, in the session's workspace.
      const called = await helper.mcp("c1", {
        id: 2,
        method: "tools/call",
        params: {
          name: "open_doc",
          arguments: { query: "cwd" },
          _meta: { "zcode/helperContext": { sessionId: SESSION, runtimeScope: "main" } },
        },
      });
      expect(called.result).toEqual({
        content: [{ type: "text", text: await realpath(home.workspace) }],
      });
      helper.close();
      await helper.done;
    }, 60_000);

  it("releases a pipe that Rust closed while it was still connecting", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    // Rust gave up on the connect (timeout, failure, dropped caller): its close arrives before the connect finishes.
    const connecting = helper.request("helper/mcp/connect", {
      connection: "c-late",
      server: SERVER,
      workspace: helper.workspace,
    });
    helper.notify("helper/mcp/close", { connection: "c-late" });
    const connected = await connecting;
    expect(connected.error?.message).toMatch(/closed while connecting/);
    const reply = (await helper.mcp("c-late", { id: 1, method: "tools/list", params: {} })) as {
      error?: { message: string };
    };
    expect(reply.error?.message).toMatch(/not open/);
    // The connection id can connect again once Rust opens it anew.
    const again = await helper.request("helper/mcp/connect", {
      connection: "c-late",
      server: SERVER,
      workspace: helper.workspace,
    });
    expect(again.error).toBeUndefined();
    helper.close();
    await helper.done;
  }, 60_000);

  it("cancels an aborted request to Rust with helper/cancelRequest", async () => {
    const sent: { id?: string; method: string; params: Record<string, unknown> }[] = [];
    const client = new ForkRustHelperClient((message) => sent.push(message as (typeof sent)[number]));
    const abort = new AbortController();
    const pending = client.request("helper/authorizeAppTool", { sessionId: SESSION }, abort.signal);
    abort.abort(new Error("panel call cancelled"));
    await expect(pending).rejects.toThrow("panel call cancelled");
    const requestKey = sent[0]?.params.requestKey;
    expect(sent[0]?.id).toBe(requestKey);
    expect(sent[1]).toEqual({ method: "helper/cancelRequest", params: { requestKey } });
    // A late answer to it settles nothing.
    expect(client.handleResponse({ jsonrpc: "2.0", id: String(requestKey), result: {} } as never)).toBe(true);
  });

  it("refuses a tool call for a session the helper has not opened", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    await helper.request("helper/mcp/connect", { connection: "c1", server: SERVER, workspace: helper.workspace });
    const reply = (await helper.mcp("c1", {
      id: 1,
      method: "tools/call",
      params: {
        name: "open_doc",
        arguments: {},
        _meta: { "zcode/helperContext": { sessionId: "sess_unknown", runtimeScope: "main" } },
      },
    })) as { error?: { code: number; message: string } };
    expect(reply.error?.message).toMatch(/not open/);
    helper.close();
    await helper.done;
  }, 60_000);

  it("aborts a pipe tool call on notifications/cancelled", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    await helper.request("helper/mcp/connect", { connection: "c1", server: SERVER, workspace: helper.workspace });
    await helper.openSession();
    helper.notify("helper/mcp/send", {
      connection: "c1",
      message: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "slow",
          arguments: {},
          _meta: { "zcode/helperContext": { sessionId: SESSION, runtimeScope: "main" } },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const answered = await helper.mcp("c1", {
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "user" },
    });
    expect(answered).toBeUndefined();
    await vi.waitFor(
      () =>
        expect(
          helper.notifications.some(
            (frame) =>
              frame.method === "helper/mcp/message" &&
              (frame.params as { message: { id?: unknown; error?: unknown } }).message.id === 7,
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    helper.close();
    await helper.done;
  }, 60_000);

  it("answers mention items through Rust's authorization of the app tool", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace, {
      "helper/authorizeAppTool": (params) =>
        (params.input as { query: string }).query === "deny"
          ? { error: { code: -32000, message: "denied", data: { type: "permission_denied" } } }
          : { result: { input: params.input } },
    });
    expect((await helper.openSession()).error).toBeUndefined();
    const reply = await helper.request("plugins/mentionItems", {
      sessionId: SESSION,
      pluginId: PLUGIN_ID,
      tool: "mention_search",
      query: "x",
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      items: [{ id: "x-1", label: "Doc x", insertText: "DOC[x]" }],
    });
    const authorize = helper.reverseRequests.find((frame) => frame.method === "helper/authorizeAppTool");
    expect(authorize?.params).toMatchObject({
      sessionId: SESSION,
      serverName: SERVER,
      toolName: "mention_search",
      input: { query: "x" },
      tool: { inputSchema: { type: "object" } },
    });

    const denied = await helper.request("plugins/mentionItems", {
      sessionId: SESSION,
      pluginId: PLUGIN_ID,
      tool: "mention_search",
      query: "deny",
    });
    expect(denied.error?.data).toMatchObject({ code: "plugin_mention_tool_denied" });
    helper.close();
    await helper.done;
  }, 60_000);

  it("answers the session's frozen reference catalog, enabled only for plugins Rust admitted", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    await helper.openSession(SESSION, [PLUGIN_ID]);
    await helper.openSession("sess_f3_other", []);
    const admitted = await helper.request("plugins/referenceCatalog", { sessionId: SESSION, workspace: helper.workspace });
    const other = await helper.request("plugins/referenceCatalog", {
      sessionId: "sess_f3_other",
      workspace: helper.workspace,
    });
    const entry = (result: Frame["result"]) =>
      (result?.plugins as { pluginId: string; enabled?: boolean }[] | undefined)?.find(
        (plugin) => plugin.pluginId === PLUGIN_ID,
      );
    expect(admitted.error).toBeUndefined();
    expect(entry(admitted.result)?.enabled).toBe(true);
    // The other session's Rust process did not admit it: listed, but not referenceable.
    expect(entry(other.result)?.enabled).toBe(false);
    helper.close();
    await helper.done;
  }, 60_000);

  it("closes a session: its methods answer session unavailable afterwards", async () => {
    const home = await tempHome();
    const helper = await initialized(home.env, home.workspace);
    await helper.openSession();
    helper.notify("helper/session/close", { sessionId: SESSION, openId: 1 });
    await vi.waitFor(async () => {
      const reply = await helper.request("plugins/mentionItems", {
        sessionId: SESSION,
        pluginId: PLUGIN_ID,
        tool: "mention_search",
        query: "x",
      });
      expect(reply.error?.code).toBe(-32004);
    });
    helper.close();
    await helper.done;
  }, 60_000);
});
