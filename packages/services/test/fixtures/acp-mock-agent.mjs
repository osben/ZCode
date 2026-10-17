#!/usr/bin/env node
/**
 * Minimal hand-rolled ACP mock for the services bridge test.
 *
 * Answers `initialize`, `session/new` and `session/prompt` with plain NDJSON
 * JSON-RPC; each prompt emits one agent_message_chunk update and completes.
 */
import { createInterface } from "node:readline";

const SESSION_ID = "services-mock-session";
const rl = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stderr.write("acp-mock-agent ready\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pong" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});

rl.on("close", () => process.exit(0));
