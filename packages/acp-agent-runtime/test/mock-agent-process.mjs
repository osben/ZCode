#!/usr/bin/env node
/**
 * Deterministic mock ACP agent for runtime tests.
 *
 * Communicates over stdio with the SDK's own agent-side builder, so the
 * runtime is exercised against real protocol framing, schemas and handlers.
 *
 * Usage: node mock-agent-process.mjs <scenario>
 */
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

process.stderr.write("mock-agent stderr ready\n");

const scenario = process.argv[2] ?? "normal";
const sessionId = "mock-session";

let cancelled = false;
let cancelWaiters = [];
let receivedCapabilities = null;
let receivedMarker = null;

const msgChunk = (text) => ({
  sessionUpdate: "agent_message_chunk",
  messageId: "m1",
  content: { type: "text", text },
});
const thoughtChunk = (text) => ({
  sessionUpdate: "agent_thought_chunk",
  messageId: "m1",
  content: { type: "text", text },
});

const app = agent({ name: `mock-agent (${scenario})` })
  .onRequest(methods.agent.initialize, (ctx) => {
    if (scenario === "hang") return new Promise(() => {});
    if (scenario === "protocol-version") {
      return { protocolVersion: 999, agentCapabilities: {} };
    }
    receivedCapabilities = ctx.params.clientCapabilities ?? null;
    receivedMarker = process.env.MOCK_MARKER ?? null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods:
        scenario === "auth"
          ? [{ id: "mock-login", name: "Mock Login", description: "Mock auth method" }]
          : [],
    };
  })
  .onRequest(methods.agent.session.new, async () => {
    if (scenario === "slow-new") {
      // Leaves a deterministic window where the runtime can "die" (a poked
      // exit handler) before the session/new response commits the handshake.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (scenario === "new-fails") throw new Error("session/new exploded");
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, () => {
    cancelled = true;
    const waiters = cancelWaiters;
    cancelWaiters = [];
    for (const resolve of waiters) resolve();
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const sid = ctx.params.sessionId;
    const notify = (update) =>
      ctx.client.notify(methods.client.session.update, { sessionId: sid, update });
    const stop = (stopReason) => ({ stopReason });

    switch (scenario) {
      case "caps": {
        await notify(msgChunk(JSON.stringify(receivedCapabilities)));
        return stop("end_turn");
      }
      case "permission": {
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Run echo",
          kind: "execute",
          status: "pending",
        });
        const response = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: sid,
          toolCall: {
            toolCallId: "tc-1",
            title: "Run echo",
            kind: "execute",
            status: "pending",
            content: [
              { type: "content", content: { type: "text", text: "Not in allowlist: echo" } },
            ],
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        const granted =
          response?.outcome?.outcome === "selected" && response.outcome.optionId === "allow-once";
        await notify(msgChunk(granted ? "granted" : "denied"));
        return stop(granted ? "end_turn" : "cancelled");
      }
      case "fs": {
        const read = await ctx.client.request(methods.client.fs.readTextFile, {
          sessionId: sid,
          path: `${process.cwd()}/read-me.txt`,
        });
        await ctx.client.request(methods.client.fs.writeTextFile, {
          sessionId: sid,
          path: `${process.cwd()}/written-by-agent.txt`,
          content: `out:${read.content}`,
        });
        await notify(msgChunk(`read:${read.content}`));
        return stop("end_turn");
      }
      case "cancel":
      case "silent":
      case "cancel-early": {
        if (scenario === "cancel") await notify(thoughtChunk("working"));
        // Simulates a slow CI runner: the cancel notification can arrive before
        // this process reaches its wait below.
        if (scenario === "cancel-early") await new Promise((r) => setTimeout(r, 400));
        await new Promise((resolve) => {
          // The client may have cancelled before this waiter was registered; a
          // bare push would then wait for the 10s fallback and force the runtime
          // to escalate to a kill.
          if (cancelled) {
            resolve();
            return;
          }
          cancelWaiters.push(resolve);
          setTimeout(resolve, 10_000);
        });
        return stop(cancelled ? "cancelled" : "end_turn");
      }
      case "ask-heartbeat": {
        // Inbound frames that are not session/update: five permission requests
        // 100ms apart, then a plain stop. Exercises stall detection on any frame.
        for (let index = 0; index < 5; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await ctx.client.request(methods.client.session.requestPermission, {
            sessionId: sid,
            toolCall: { toolCallId: `hb-${index}`, title: "Heartbeat", kind: "execute" },
            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
          });
        }
        return stop("end_turn");
      }
      case "die": {
        await notify(msgChunk("alive"));
        setTimeout(() => process.exit(7), 150);
        return stop("end_turn");
      }
      case "die-mid": {
        await notify(thoughtChunk("starting"));
        setTimeout(() => process.exit(9), 150);
        return new Promise(() => {});
      }
      case "auth": {
        await notify(msgChunk("ok"));
        return stop("end_turn");
      }
      case "env": {
        await notify(msgChunk(`env:${receivedMarker ?? "missing"}`));
        return stop("end_turn");
      }
      case "echo": {
        const described = ctx.params.prompt
          .map((block) => (block.type === "text" ? block.text : block.type))
          .join(",");
        await notify(msgChunk(`got:${described}`));
        return stop("end_turn");
      }
      case "noise": {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: "other-session",
          update: msgChunk("foreign"),
        });
        await notify({
          sessionUpdate: "user_message_chunk",
          messageId: "u1",
          content: { type: "text", text: "echo" },
        });
        await notify(msgChunk("own"));
        return stop("end_turn");
      }
      case "big": {
        // Only the explicit "big" prompt trips the frame limit; any other
        // prompt answers normally, so tests can exercise the restart after a
        // framing failure on the same scenario.
        const askedBig = ctx.params.prompt.some(
          (block) => block.type === "text" && block.text.includes("big"),
        );
        if (askedBig) {
          await notify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(200_000) },
          });
          return stop("end_turn");
        }
        await notify(msgChunk("small"));
        return stop("end_turn");
      }
      default: {
        await notify(msgChunk("hello"));
        await notify(thoughtChunk("thinking"));
        await notify({
          sessionUpdate: "tool_call",
          toolCallId: "tc-9",
          title: "Edit File",
          kind: "edit",
          status: "pending",
        });
        await notify({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-9",
          status: "completed",
        });
        await notify({
          sessionUpdate: "plan",
          entries: [{ content: "step one", priority: "high", status: "pending" }],
        });
        await notify({
          sessionUpdate: "usage_update",
          used: 120,
          size: 200_000,
          cost: { amount: 0, currency: "USD" },
        });
        await notify({ sessionUpdate: "session_info_update", title: "Mock Title" });
        await notify({
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "mock-cmd", description: "Mock command" }],
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
    }
  });

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
