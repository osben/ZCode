#!/usr/bin/env node
/**
 * Deterministic mock ACP agent for runtime tests.
 *
 * Communicates over stdio with the SDK's own agent-side builder, so the
 * runtime is exercised against real protocol framing, schemas and handlers.
 *
 * Usage: node mock-agent-process.mjs <scenario>
 *
 * `ACP_MOCK_CONFIG` selects the session configuration the agent advertises in `session/new` and
 * `session/load`: "options" (configOptions: a "mode" select agent|plan|ask, a grouped "model" select
 * m1|m2 and a boolean that clients must drop), "legacy" (only `modes`: build|plan), or unset (neither).
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

const configMode = process.env.ACP_MOCK_CONFIG ?? null;
const configValues = { mode: "agent", model: "m1" };
let currentModeId = "build";

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: configValues.mode,
      options: [
        { value: "agent", name: "Agent", description: "Edits files" },
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
        { group: "fast", name: "Fast", options: [{ value: "m1", name: "Model 1" }] },
        { group: "smart", name: "Smart", options: [{ value: "m2", name: "Model 2" }] },
      ],
    },
    { id: "auto", name: "Auto approve", type: "boolean", currentValue: false },
  ];
}

/** The configuration part of a `session/new` or `session/load` response. */
function sessionConfig() {
  if (configMode === "options") return { configOptions: configOptions() };
  if (configMode === "legacy") {
    return {
      modes: {
        currentModeId,
        availableModes: [
          { id: "build", name: "Build", description: "Default agent" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  }
  return {};
}

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
      agentCapabilities: { loadSession: scenario.startsWith("load") },
      authMethods:
        scenario === "auth"
          ? [{ id: "mock-login", name: "Mock Login", description: "Mock auth method" }]
          : [],
    };
  })
  // `load` replays one history chunk before it answers; `load-fails` refuses the load;
  // `load-config` also replays a config update that must not reach the client's snapshot.
  .onRequest(methods.agent.session.load, async (ctx) => {
    if (scenario === "load-fails") throw new Error("session/load refused");
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: msgChunk("replayed"),
    });
    if (scenario === "load-config") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: "ask" },
      });
    }
    return sessionConfig();
  })
  .onRequest(methods.agent.session.new, async () => {
    if (scenario === "slow-new") {
      // Leaves a deterministic window where the runtime can "die" (a poked
      // exit handler) before the session/new response commits the handshake.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (scenario === "new-fails") throw new Error("session/new exploded");
    return { sessionId, ...sessionConfig() };
  })
  .onRequest(methods.agent.session.setConfigOption, (ctx) => {
    const { configId, value } = ctx.params;
    const option = configOptions().find((candidate) => candidate.id === configId);
    if (configMode !== "options" || !option || option.type !== "select") {
      throw new Error(`unknown config option ${configId}`);
    }
    const values = option.options.flatMap((entry) => entry.options ?? [entry]);
    if (!values.some((entry) => entry.value === value)) {
      throw new Error(`invalid value ${String(value)} for ${configId}`);
    }
    configValues[configId] = value;
    return { configOptions: configOptions() };
  })
  .onRequest(methods.agent.session.setMode, (ctx) => {
    if (configMode !== "legacy") throw new Error("modes are not supported");
    currentModeId = ctx.params.modeId;
    return {};
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
      // A prompt whose text contains "stuck" never settles, even after session/cancel: only the runtime's
      // kill escalation ends it. Other prompts complete, so a restarted process can serve the next turn.
      case "stuck":
        if (
          ctx.params.prompt.some((block) => block.type === "text" && block.text.includes("stuck"))
        ) {
          return new Promise(() => {});
        }
        return stop("end_turn");
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
      case "die":
      case "load-die": {
        await notify(msgChunk("alive"));
        setTimeout(() => process.exit(7), 150);
        return stop("end_turn");
      }
      case "die-mid": {
        await notify(thoughtChunk("starting"));
        setTimeout(() => process.exit(9), 150);
        return new Promise(() => {});
      }
      // Prompt text markers emit agent-initiated configuration changes during the turn.
      case "config":
      case "load-config": {
        const text = ctx.params.prompt
          .map((block) => (block.type === "text" ? block.text : ""))
          .join(" ");
        if (text.includes("foreign")) {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: "other-session",
            update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
          });
        }
        if (text.includes("config-update")) {
          configValues.model = "m2";
          await notify({ sessionUpdate: "config_option_update", configOptions: configOptions() });
        }
        if (text.includes("mode-update")) {
          currentModeId = "plan";
          configValues.mode = "plan";
          await notify({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
        }
        return stop("end_turn");
      }
      // Silent past the stall window, then two chunks: the first frame after the stall resumes it.
      case "stall-resume": {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await notify(msgChunk("back"));
        await notify(msgChunk("again"));
        return stop("end_turn");
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
