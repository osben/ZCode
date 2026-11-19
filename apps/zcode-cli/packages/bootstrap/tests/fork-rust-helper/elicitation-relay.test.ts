// Fork: the helper's relay of a helper-hosted server's elicitation/create to Rust (specs/fork-rust-node-helper.md,
// "Elicitation from helper-hosted servers"; F3b(c) PR 2). The relay attaches a question to the newest pipe tool call
// of its server, asks Rust through `helper/elicitation`, and answers the server with Rust's result.
import { describe, expect, it } from "vitest";
import { ElicitationRelay } from "../../src/fork-rust-helper/elicitation-relay.js";

const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
const SERVER = "plugin:calc:app";
const CALL = { sessionId: "sess_1", turnId: "run_1", toolUseId: "toolu_1" };

interface Ask {
  params: Record<string, unknown>;
  signal: AbortSignal;
}

/** A relay whose asks are recorded; `answer` decides each ask (it may hang until its signal aborts). */
function relayWith(answer: (ask: Ask) => Promise<unknown>) {
  const asks: Ask[] = [];
  const relay = new ElicitationRelay((params, signal) => {
    const ask = { params, signal };
    asks.push(ask);
    return answer(ask);
  });
  return { relay, asks };
}

const question = { serverName: SERVER, message: "Name?", requestedSchema: schema };

/** Rejects when the ask's signal aborts, as the client's request does on its cancel. */
const hang = ({ signal }: Ask) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never held");
}

describe("fork: helper elicitation relay", () => {
  it("declines without asking when no pipe call of the server is in flight", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: {} }));
    await expect(relay.elicit(question)).resolves.toEqual({ action: "decline" });
    expect(asks).toHaveLength(0);
  });

  it("asks Rust with the session, the turn, the tool call and the schema, and answers accept with its content", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: { name: "Ada" } }));
    relay.enterCall(SERVER, CALL);
    await expect(relay.elicit(question)).resolves.toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
    expect(asks[0]?.params).toEqual({
      sessionId: "sess_1",
      turnId: "run_1",
      toolUseId: "toolu_1",
      server: SERVER,
      message: "Name?",
      requestedSchema: schema,
    });
  });

  it("answers an accept without content with an empty content object", async () => {
    const { relay } = relayWith(async () => ({ action: "accept" }));
    relay.enterCall(SERVER, CALL);
    await expect(relay.elicit(question)).resolves.toEqual({ action: "accept", content: {} });
  });

  it("answers Rust's decline and cancel as they are", async () => {
    const { relay } = relayWith(async (ask) =>
      ask.params.message === "Decline?" ? { action: "decline" } : { action: "cancel" },
    );
    relay.enterCall(SERVER, CALL);
    await expect(relay.elicit({ ...question, message: "Decline?" })).resolves.toEqual({
      action: "decline",
    });
    await expect(relay.elicit({ ...question, message: "Cancel?" })).resolves.toEqual({
      action: "cancel",
    });
  });

  it("declines when Rust answers another kind, or the ask fails", async () => {
    const { relay } = relayWith(async (ask) => {
      if (ask.params.message === "Other?") return { action: "bogus" };
      throw new Error("Rust refused");
    });
    relay.enterCall(SERVER, CALL);
    await expect(relay.elicit({ ...question, message: "Other?" })).resolves.toEqual({
      action: "decline",
    });
    await expect(relay.elicit(question)).resolves.toEqual({ action: "decline" });
  });

  it("declines a call without a tool use id, since no question can be attributed to it", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: {} }));
    relay.enterCall(SERVER, { sessionId: "sess_1" });
    await expect(relay.elicit(question)).resolves.toEqual({ action: "decline" });
    expect(asks).toHaveLength(0);
  });

  it("declines a mode other than form without asking", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: {} }));
    relay.enterCall(SERVER, CALL);
    const urlQuestion = { ...question, mode: "url", url: "https://example.com" };
    await expect(relay.elicit(urlQuestion)).resolves.toEqual({ action: "decline" });
    expect(asks).toHaveLength(0);
  });

  it("withdraws an open question when its call ends: the ask is abandoned and the server gets cancel", async () => {
    const { relay, asks } = relayWith(hang);
    const endCall = relay.enterCall(SERVER, CALL);
    const answered = relay.elicit(question);
    await waitFor(() => asks.length === 1);
    endCall();
    await expect(answered).resolves.toEqual({ action: "cancel" });
    expect(asks[0]?.signal.aborted).toBe(true);
  });

  it("declines a question that arrives after its call ended", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: {} }));
    relay.enterCall(SERVER, CALL)();
    await expect(relay.elicit(question)).resolves.toEqual({ action: "decline" });
    expect(asks).toHaveLength(0);
  });

  it("attaches to the newest call of the server, and an older call still in flight takes it back", async () => {
    const { relay, asks } = relayWith(async (ask) =>
      ask.params.toolUseId === "toolu_2"
        ? { action: "accept", content: { name: "new" } }
        : { action: "accept", content: { name: "old" } },
    );
    const endOlder = relay.enterCall(SERVER, { ...CALL, toolUseId: "toolu_1" });
    const endNewer = relay.enterCall(SERVER, { ...CALL, toolUseId: "toolu_2" });
    await expect(relay.elicit(question)).resolves.toEqual({
      action: "accept",
      content: { name: "new" },
    });
    endNewer();
    await expect(relay.elicit(question)).resolves.toEqual({
      action: "accept",
      content: { name: "old" },
    });
    expect(asks.map((ask) => ask.params.toolUseId)).toEqual(["toolu_2", "toolu_1"]);
    endOlder();
  });

  it("does not attach a question of one server to a call of another", async () => {
    const { relay, asks } = relayWith(async () => ({ action: "accept", content: {} }));
    relay.enterCall("plugin:other:app", CALL);
    await expect(relay.elicit(question)).resolves.toEqual({ action: "decline" });
    expect(asks).toHaveLength(0);
  });
});
