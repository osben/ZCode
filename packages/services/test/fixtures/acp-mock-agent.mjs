#!/usr/bin/env node
/**
 * Hand-rolled ACP mock for the services bridge test and the desktop E2E.
 *
 * Answers `initialize`, `session/new`, `session/load` and `session/prompt` with plain NDJSON JSON-RPC.
 * The reply depends on markers in the prompt text, checked in this order:
 *   - "hang": the prompt stays pending until `session/cancel` (the Stop scenario).
 *   - "tool": a read tool call (pending, in progress, completed with output) and a message.
 *   - "plan": a plan with three steps.
 *   - "title": a session title update.
 *   - "permission": asks the client `session/request_permission`; the reply is "permission granted",
 *     "permission denied", or a cancelled stop when the client cancels the ask.
 *   - "remember <word>" and "recall": store and read a word in the state file (the relaunch scenario).
 *   - anything else: "pong".
 * `session/load` replays one history chunk ("replayed history") before it answers, so a test can prove
 * the replay is not shown. `--state <file>` keeps memory and a method log across processes.
 *
 * Session configuration (specs/acp-agent-runtime.md "S6"), chosen by `--config <mode>` or the
 * `ACP_MOCK_CONFIG` env variable (the flag wins):
 *   - "options": `session/new` and `session/load` return `configOptions` with a "mode" select
 *     (agent|plan|ask, current "agent") and a "model" select (m1|m2, current "m1").
 *   - "legacy": they return only `modes` (build|plan, current "build").
 *   - unset: neither.
 * `session/set_config_option` and `session/set_mode` validate and apply the value. The method log in the
 * state file is a list of strings in arrival order: "process-start", "session/new", "session/load",
 * "session/prompt", "session/set_config_option <configId>=<value>" and "session/set_mode <modeId>".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SESSION_ID = "services-mock-session";
const HANG_MARKER = "hang";
const argv = process.argv.slice(2);
const stateIndex = argv.indexOf("--state");
const STATE_FILE = stateIndex >= 0 ? argv[stateIndex + 1] : undefined;
const configIndex = argv.indexOf("--config");
const CONFIG_MODE = (configIndex >= 0 ? argv[configIndex + 1] : process.env.ACP_MOCK_CONFIG) ?? "";
const configValues = { mode: "agent", model: "m1" };
let currentModeId = "build";
const rl = createInterface({ input: process.stdin });
const pendingClientRequests = new Map();
let pendingHangId;
let nextRequestId = 1000;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (sessionId, update) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const message = (text) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

function readState() {
  if (STATE_FILE === undefined || !existsSync(STATE_FILE)) return { memory: null, methods: [] };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function recordMethod(method) {
  if (STATE_FILE === undefined) return;
  const state = readState();
  state.methods.push(method);
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function rememberWord(word) {
  if (STATE_FILE === undefined) return;
  const state = readState();
  state.memory = word;
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: configValues.mode,
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: configValues.model,
      options: [
        { value: "m1", name: "Model 1" },
        { value: "m2", name: "Model 2" },
      ],
    },
  ];
}

/** The configuration part of a `session/new` or `session/load` response. */
function sessionConfig() {
  if (CONFIG_MODE === "options") return { configOptions: configOptions() };
  if (CONFIG_MODE === "legacy") {
    return {
      modes: {
        currentModeId,
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  }
  return {};
}

const fail = (id, text) => send({ jsonrpc: "2.0", id, error: { code: -32602, message: text } });

function handleSetConfigOption(request) {
  const configId = request.params?.configId;
  const value = request.params?.value;
  recordMethod(`session/set_config_option ${String(configId)}=${String(value)}`);
  const option = configOptions().find((candidate) => candidate.id === configId);
  if (CONFIG_MODE !== "options" || !option) {
    return fail(request.id, `unknown config option ${String(configId)}`);
  }
  if (!option.options.some((entry) => entry.value === value)) {
    return fail(request.id, `invalid value ${String(value)} for ${String(configId)}`);
  }
  configValues[configId] = value;
  send({ jsonrpc: "2.0", id: request.id, result: { configOptions: configOptions() } });
}

function handleSetMode(request) {
  const modeId = request.params?.modeId;
  recordMethod(`session/set_mode ${String(modeId)}`);
  if (CONFIG_MODE !== "legacy" || (modeId !== "build" && modeId !== "plan")) {
    return fail(request.id, `invalid mode ${String(modeId)}`);
  }
  currentModeId = modeId;
  send({ jsonrpc: "2.0", id: request.id, result: {} });
}

process.stderr.write("acp-mock-agent ready\n");
recordMethod("process-start");

/** Asks the client for permission; resolves with the client's answer to this request. */
function askPermission(sessionId) {
  const id = nextRequestId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "perm-tool",
        title: "Run the tests",
        kind: "execute",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "pnpm test" } }],
      },
      options: [
        { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
        { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
        { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  return new Promise((resolve) => pendingClientRequests.set(id, resolve));
}

async function handlePrompt(request) {
  const sessionId = request.params?.sessionId ?? SESSION_ID;
  const text = (request.params?.prompt ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  const done = (stopReason) => send({ jsonrpc: "2.0", id: request.id, result: { stopReason } });

  if (text.includes(HANG_MARKER)) {
    pendingHangId = request.id;
    return;
  }
  if (text.includes("tool")) {
    notify(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read a.txt",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "a.txt" },
    });
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file body" } }],
    });
    notify(sessionId, message("tool finished"));
    return done("end_turn");
  }
  if (text.includes("plan")) {
    notify(sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the spec", priority: "high", status: "completed" },
        { content: "Write the tests", priority: "medium", status: "in_progress" },
        { content: "Ship the change", priority: "low", status: "pending" },
      ],
    });
    notify(sessionId, message("planned"));
    return done("end_turn");
  }
  if (text.includes("title")) {
    notify(sessionId, { sessionUpdate: "session_info_update", title: "Parser fix from ACP" });
    notify(sessionId, message("titled"));
    return done("end_turn");
  }
  if (text.includes("permission")) {
    const answer = await askPermission(sessionId);
    const optionId = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : null;
    if (optionId === "opt-allow") {
      notify(sessionId, message("permission granted"));
      return done("end_turn");
    }
    if (optionId === "opt-reject") {
      notify(sessionId, message("permission denied"));
      return done("end_turn");
    }
    return done("cancelled");
  }
  const remembered = /remember (\S+)/.exec(text);
  if (remembered) {
    rememberWord(remembered[1]);
    notify(sessionId, message("remembered"));
    return done("end_turn");
  }
  if (text.includes("recall")) {
    notify(sessionId, message(`recalled ${readState().memory ?? "nothing"}`));
    return done("end_turn");
  }
  notify(sessionId, message("pong"));
  return done("end_turn");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  // A response to a request this mock sent (a permission ask): resolve the waiting prompt.
  if (request.method === undefined && request.id !== undefined) {
    const resolve = pendingClientRequests.get(request.id);
    if (resolve) {
      pendingClientRequests.delete(request.id);
      resolve(request.result);
    }
    return;
  }
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
        authMethods: [],
      },
    });
    return;
  }
  if (request.method === "session/new") {
    recordMethod("session/new");
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: SESSION_ID, ...sessionConfig() } });
    return;
  }
  if (request.method === "session/load") {
    recordMethod("session/load");
    notify(request.params?.sessionId ?? SESSION_ID, message("replayed history"));
    send({ jsonrpc: "2.0", id: request.id, result: sessionConfig() });
    return;
  }
  if (request.method === "session/set_config_option") {
    handleSetConfigOption(request);
    return;
  }
  if (request.method === "session/set_mode") {
    handleSetMode(request);
    return;
  }
  if (request.method === "session/prompt") {
    recordMethod("session/prompt");
    void handlePrompt(request);
    return;
  }
  if (request.method === "session/cancel") {
    if (pendingHangId !== undefined) {
      send({ jsonrpc: "2.0", id: pendingHangId, result: { stopReason: "cancelled" } });
      pendingHangId = undefined;
    }
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
});

rl.on("close", () => process.exit(0));
