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
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SESSION_ID = "services-mock-session";
const HANG_MARKER = "hang";
const argv = process.argv.slice(2);
const stateIndex = argv.indexOf("--state");
const STATE_FILE = stateIndex >= 0 ? argv[stateIndex + 1] : undefined;
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
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (request.method === "session/load") {
    recordMethod("session/load");
    notify(request.params?.sessionId ?? SESSION_ID, message("replayed history"));
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "session/prompt") {
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
