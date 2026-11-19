// Fork: the helper's relay of a helper-hosted server's elicitation/create to Rust (specs/fork-rust-node-helper.md,
// "Elicitation from helper-hosted servers"; F3b(c) PR 2). The relay attaches a question to the newest pipe tool call
// of its server, asks Rust through `helper/elicitation`, and answers the server with Rust's result.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ElicitationRelay } from "../../src/fork-rust-helper/elicitation-relay.js";

/**
 * The contract both runtimes read (the same file the Rust test helper_elicitation_tests.rs parses): the call, the question,
 * the params `helper/elicitation` must carry, and the answer shapes Rust returns.
 */
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../packages/rust-cli/crates/protocol-zcode/src/fork/helper_elicitation_contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  call: { sessionId: string; turnId: string; toolUseId: string };
  question: { serverName: string; message: string; requestedSchema: unknown };
  request: Record<string, unknown>;
  answers: { accept: unknown; decline: unknown; cancel: unknown };
};

const schema = contract.question.requestedSchema;
const SERVER = contract.question.serverName;
const CALL = contract.call;

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
    // The wire params are the contract's: the keys Rust reads, nothing else.
    expect(asks[0]?.params).toEqual(contract.request);
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

  it("answers with the contract's answer shapes, which Rust returns", async () => {
    const answers = [contract.answers.accept, contract.answers.decline, contract.answers.cancel];
    for (const answer of answers) {
      const { relay } = relayWith(async () => answer);
      relay.enterCall(SERVER, CALL);
      await expect(relay.elicit(question)).resolves.toEqual(answer);
    }
  });

  it("logs a failed ask and declines, but a withdrawal is silent", async () => {
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };
    const failing = new ElicitationRelay(async () => {
      throw new Error("Rust refused");
    }, logger);
    failing.enterCall(SERVER, CALL);
    await expect(failing.elicit(question)).resolves.toEqual({ action: "decline" });
    expect(warnings).toHaveLength(1);

    const asks: Ask[] = [];
    const withdrawing = new ElicitationRelay((params, signal) => {
      asks.push({ params, signal });
      return hang({ params, signal });
    }, logger);
    const endCall = withdrawing.enterCall(SERVER, CALL);
    const answered = withdrawing.elicit(question);
    await waitFor(() => asks.length === 1);
    endCall();
    await expect(answered).resolves.toEqual({ action: "cancel" });
    expect(warnings).toHaveLength(1);
  });
});
