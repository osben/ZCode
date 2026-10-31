/**
 * Deterministic integration tests (phase 1.5 step 7, CI-safe layer): real AgentRuntime driver +
 * scripted model, exercising the dynamic-workflow engine ↔ real runtime submit bridging. See
 * docs/execution-engine.md "The driver (Boundary B)" and "Typed asks and `submit_result`".
 *
 * This file first establishes the minimal accept path, verifying the three-valued→two-valued
 * verdict mapping and submit→turn-stop; the remaining scenarios (same-turn repair, nudge,
 * untyped, world-read) spread across later describes.
 */

import { describe, expect, it, vi } from "vitest";
import { createTestAgentRuntime } from "./helpers/test-agent-runtime.js";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  SUBMIT_RESULT_TOOL_NAME,
  type ModelRequest,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import {
  inputHash,
  InMemoryJournalStore,
  refToString,
  type ActorRef,
  type ActorSessionSeed,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import type { ActorTranscriptStore } from "../src/app/workflow-actor-transcript.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import {
  createAgentRuntimeWorkflowDriver,
  mintActorSessionId,
} from "../src/app/workflow-driver.js";
import {
  fakeFileSystemPort,
  runDriverScript,
  unsupportedExecutionPort,
} from "./workflow-driver.helpers.js";

const RUN = "run";

describe("workflow driver — accept path", () => {
  it("bridges a valid submit through the real runtime and returns the artifact", async () => {
    const script = [
      "interface Summary { title: string; points: string[]; }",
      'const worker = agent("worker", "You summarize repos.");',
      'const s = await worker.ask<Summary>("Summarize the repo");',
      "log(`title: ${s.title}`);",
      "return s;",
    ].join("\n");

    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, events, modelCalls } = await runDriverScript(script, {
      caps: { maxConcurrency: 16 },
      actorScripts: {
        // actor#1@1's persistent runtime: the first model request submits a valid result.
        "actor#1@1": [{ kind: "submit", result: artifact }],
      },
    });

    // Settlement: the script's returned artifact bubbles out verbatim.
    expect(settlement).toEqual({ status: "completed", artifact });

    // Journal: the ask node is completed with actorSeq / inputHash / result / actor attribution.
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.result).toEqual(artifact);
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("Summarize the repo"));
    expect(node?.actorSiteId).toBe("actor#1");

    // Stats come from the real turn's usage. On the accept path stats arrive after settle (the
    // real runtime knows usage only once the turn resolves, i.e. after submit); the engine's
    // post-settle backfill writes them into the already-settled journal node.
    expect(node?.stats?.tokens ?? 0).toBeGreaterThan(0);
    expect(node?.stats?.turns).toBeGreaterThanOrEqual(1);

    // Run-level usage is also accumulated (askStats unconditionally adds spentTokens), as extra coverage.
    const usageEvents = events.filter((e) => e.type === "usage-updated");
    const lastUsage = usageEvents.at(-1);
    expect(lastUsage?.type === "usage-updated" && lastUsage.spentTokens).toBeGreaterThan(0);

    // Completes with a single model request (no repair, no nudge).
    expect(modelCalls["actor#1@1"]?.calls).toBe(1);

    // Event stream: run-started → actor-created → node-dispatched → node-settled(ok) → run-settled(completed).
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types).toContain("actor-created");
    expect(types).toContain("node-dispatched");
    const settled = events.filter((e) => e.type === "node-settled");
    expect(settled.at(-1)).toMatchObject({ outcome: "ok" });
    expect(types.at(-1)).toBe("run-settled");
  });
});

const TYPED_ASK_SCRIPT = [
  "interface Summary { title: string; points: string[]; }",
  'const worker = agent("worker", "You summarize repos.");',
  'const s = await worker.ask<Summary>("Summarize the repo");',
  "return s;",
].join("\n");

describe("workflow driver — in-session repair (reject)", () => {
  it("rejects an invalid submit, retries within the same turn, then accepts", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { settlement, journal, events, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // Within the same turn: submit invalid first (title wrong type, points missing) → engine
        // rejects → error tool_result → the model retries in-session → submits valid → accept.
        "actor#1@1": [
          { kind: "submit", result: { title: 42 } },
          { kind: "submit", result: valid },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: valid });
    // Repair is a real in-session tool_result retry: 2 model requests happened within one turn.
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
    // The engine emitted one node-repairing (with the violation) and finally settled(ok).
    const repairing = events.filter((e) => e.type === "node-repairing");
    expect(repairing.length).toBe(1);
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
  });

  it("fails the ask with ValidationFailed after the repair attempts are exhausted", async () => {
    // Repair cap is 3: after 4 invalid submissions exhaust it, the engine cancelAsk + settleFailed(ValidationFailed).
    const invalid = { kind: "submit" as const, result: { title: 1 } };
    const { settlement, journal, events } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: { "actor#1@1": [invalid, invalid, invalid, invalid] },
    });

    // The ask rejection bubbles across Boundary A as a script throw → the run fails.
    expect(settlement.status).toBe("errored");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ValidationFailed");
    // Exhausted after 3 repair attempts.
    expect(events.filter((e) => e.type === "node-repairing").length).toBe(3);
  });
});

describe("workflow driver — nudge", () => {
  it("nudges a turn that ended without a submit, then accepts on the fresh turn", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { settlement, events, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // First turn sends only text (no submit) → engine nudges → a fresh turn submits valid → accept.
        "actor#1@1": [
          { kind: "text", text: "Here is the summary." },
          { kind: "submit", result: valid },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: valid });
    // A nudge is a fresh executeTurn on the same persistent runtime: 2 model requests in total.
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
    expect(events.filter((e) => e.type === "node-nudged").length).toBe(1);
  });

  it("fails with ResultNotSubmitted when nudge is exhausted", async () => {
    // Nudge budget is 1: neither turn submits → cancelAsk + settleFailed(ResultNotSubmitted).
    const { settlement, journal, events } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "text", text: "no submit 1" },
          { kind: "text", text: "no submit 2" },
        ],
      },
    });

    expect(settlement.status).toBe("errored");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ResultNotSubmitted");
    expect(events.filter((e) => e.type === "node-nudged").length).toBe(1);
  });
});

describe("workflow driver — untyped ask", () => {
  it("settles an untyped ask from the turn's final text (no submit_result)", async () => {
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("What is 2 + 2?");',
      "return answer;",
    ].join("\n");

    const { settlement, journal } = await runDriverScript(script, {
      actorScripts: { "actor#1@1": [{ kind: "text", text: "The answer is 4." }] },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "The answer is 4." });
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("The answer is 4.");
  });

  it("guards submit_result called on an untyped ask without hanging", async () => {
    // If the model mistakenly calls submit_result on an untyped ask: the driver intercepts
    // locally and answers with a synthetic rejection (no engine report, no hang); the model
    // switches to plain text, and the untyped ask settles from the final text.
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("Say hello.");',
      "return answer;",
    ].join("\n");

    const { settlement, modelCalls } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { foo: "bar" } },
          { kind: "text", text: "hello there" },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hello there" });
    // The interception does not hang: submit rejected in the first turn → the model answers with text → 2 model requests in total.
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
  });
});

describe("workflow driver — lenient stringified submit", () => {
  it("accepts a submit whose result is a stringified JSON object and journals the parsed object", async () => {
    // Found in production: real models (GLM-5.3 via the Anthropic-compatible endpoint) often pass
    // submit_result's result as a JSON string rather than an object. The engine parses leniently
    // in a schema-aware way (scheduler.normalizeSubmit); end to end this should accept and journal
    // the parsed object.
    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // The result is a STRING (the object's JSON encoding), not the object itself.
        "actor#1@1": [{ kind: "submit", result: JSON.stringify(artifact) }],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact });
    // Accepted on a single model request (no repair).
    expect(modelCalls["actor#1@1"]?.calls).toBe(1);
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    // What lands in the journal is the parsed object, not the raw string.
    expect(node?.result).toEqual(artifact);
  });
});

describe("workflow driver — actor tool surface", () => {
  // The actor tool surface used to be ignored entirely by the runtime factory — production
  // transcripts showed judges getting AskUserQuestion / CreateWorkflow too. What is asserted
  // here is the tool names **actually** carried on the model request, not config fields, since
  // core's filtering and the embedded-search branch sit in between.
  const PROFILE_SCRIPT = (persona: string) =>
    [
      "interface Verdict { approved: boolean; }",
      `const judge = ${persona};`,
      'const v = await judge.ask<Verdict>("Approve it?");',
      "return v;",
    ].join("\n");

  /** Run a single-ask typed script once and return the tool-name list of that actor's first model request. */
  async function toolNamesForPersona(persona: string): Promise<string[]> {
    const { settlement, modelCalls } = await runDriverScript(PROFILE_SCRIPT(persona), {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });
    // First confirm the ask actually ran: if the tool surface filtered out submit_result, the run fails rather than returning an empty list.
    expect(settlement).toEqual({ status: "completed", artifact: { approved: true } });
    const names = modelCalls["actor#1@1"]?.toolNames[0];
    return names ?? [];
  }

  it("keeps the full working set for every actor, minus question, plan-mode and meta tools", async () => {
    const names = await toolNamesForPersona('agent("worker", "You do work.")');
    // Every actor works as usual (no tool tiers since 2026-09-12, docs/dynamic-workflow/authoring.md).
    for (const expected of ["Bash", "Edit", "Write", SUBMIT_RESULT_TOOL_NAME]) {
      expect(names).toContain(expected);
    }
    // Subagents do not ask humans: judgments needing a human go to the main agent via escalate
    // (docs/dynamic-workflow/launch.md "Permissions inside a run"); plan approval is not a
    // subagent's business, CreateWorkflow would submit workflows recursively, and
    // ReadSessionContext reads the parent session out of bounds — all removed.
    for (const forbidden of [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "CreateWorkflow",
      "ReadSessionContext",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("workflow driver — resume by replay", () => {
  it("short-circuits journaled nodes on resume with zero actor dispatches", async () => {
    const script = [
      "interface Verdict { approved: boolean; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const v = await agent("reviewer").ask<Verdict>(`Review ${paths.length} files`);',
      "return { count: paths.length, approved: v.approved };",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const files = { glob: ["src/a.ts", "src/b.ts"] };
    const artifact = { count: 2, approved: true };

    // First run: one live-dispatched ask, journaled.
    const first = await runDriverScript(script, {
      journal,
      files,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });
    expect(first.settlement).toEqual({ status: "completed", artifact });
    expect(first.modelCalls["actor#1@1"]?.calls).toBe(1);

    // Re-run the same script against the same journal: every node short-circuits on the journal,
    // the driver creates no actor session (runtimeFactory never called → modelCalls empty) and
    // issues no startAsk.
    const resumed = await runDriverScript(script, {
      journal,
      files,
      // If resume mistakenly triggered a live dispatch, the script would hang/fail for lack of an answer — the empty script asserts "zero dispatches".
      actorScripts: {},
    });
    expect(resumed.settlement).toEqual({ status: "completed", artifact });
    expect(Object.keys(resumed.modelCalls)).toHaveLength(0);
    // Boundary C: the resumed ask's settle events carry the cached flag.
    const cachedSettles = resumed.events.filter(
      (e) => e.type === "node-settled" && e.cached === true,
    );
    expect(cachedSettles.length).toBeGreaterThan(0);
  });
});

describe("workflow driver — world reads", () => {
  it("executes glob/read via the fs port and threads results into a typed ask", async () => {
    const script = [
      "interface Verdict { approved: boolean; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const first = paths[0] ?? "none";',
      "const text = await files.read(first);",
      'const v = await agent("reviewer").ask<Verdict>(`Review ${first} (${text.length} bytes)`);',
      "return { count: paths.length, first, approved: v.approved };",
    ].join("\n");

    const { settlement, journal } = await runDriverScript(script, {
      files: { glob: ["src/a.ts", "src/b.ts"], read: "export const x = 1;\n" },
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { count: 2, first: "src/a.ts", approved: true },
    });
    // world-reads land in the journal with their results.
    const glob = journal.getNode(RUN, "world-read#1", 1);
    expect(glob?.kind).toBe("world-read");
    expect(glob?.result).toEqual(["src/a.ts", "src/b.ts"]);
    const read = journal.getNode(RUN, "world-read#2", 1);
    expect(read?.result).toBe("export const x = 1;\n");
  });
});

describe("workflow driver — actor session ids", () => {
  /**
   * Two properties of session ids (the spec's Invariants: collision-free, charset-safe without `#`/`@`/`/`).
   *
   * Sanitize is two steps and the order is the contract: first escape literal `_` to `__`, then map
   * every character outside `[A-Za-z0-9.-]` to a single `_`. Without the escaping step, `a_b` and
   * `a#b` would collapse to the same string — not hypothetical: it would rest "collision-free" on
   * the premise "the site-id vocabulary contains no underscore", owned by the analyzer (not this
   * file).
   */
  async function sessionIdsFor(runId: string): Promise<string[]> {
    const ids: string[] = [];
    await runDriverScript(['const a = await agent("w").ask("go");', "return a;"].join("\n"), {
      actorScripts: {},
      runId,
      runtimeFactory: ({ sessionId }) => {
        ids.push(sessionId);
        // Minimal stub: the driver just needs an object that can executeTurn; this case looks only at session ids.
        return {
          close: async () => {},
          executeTurn: async () => ({ response: "ok", events: [], usage: undefined }),
        } as never;
      },
    });
    return ids;
  }

  it("会话 id 含 runId 且不含 # @ /", async () => {
    const ids = await sessionIdsFor("dwfrun-plain");

    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain("dwfrun-plain");
    // refToString(actor) is `actor#1@1` — both characters must already be collapsed.
    expect(ids[0]).not.toMatch(/[#@/]/);
  });

  it("下划线转义使 sanitize 可逆到不碰撞：a_b 与 a#b 不折叠成同一个 id", async () => {
    const [underscore] = await sessionIdsFor("a_b");
    const [hash] = await sessionIdsFor("a#b");

    // Under a naive allowlist these two would be equal; escaping first keeps them distinguishable.
    expect(underscore).not.toBe(hash);
    expect(underscore).toContain("a__b");
    expect(hash).toContain("a_b");
  });

  // Adversarial pairs: every homoglyph risk between the site-id vocabulary's special characters
  // (`#`/`@`) and literal underscores. A naive allowlist (`_` both whitelisted and the
  // replacement character) collapses each pair to one string — these three pairs are that
  // approach's counterexamples and the entire reason the escape-first step exists.
  it("对抗性对子逐对不碰撞（actor#1 vs actor_1 等）", async () => {
    const pairs: readonly [string, string][] = [
      ["actor#1", "actor_1"],
      ["actor#1@2", "actor_1@2"],
      ["ask#3/2", "ask_3_2"],
    ];

    for (const [left, right] of pairs) {
      const [leftId] = await sessionIdsFor(left);
      const [rightId] = await sessionIdsFor(right);
      expect(leftId, `${left} vs ${right}`).not.toBe(rightId);
      // And both are charset-safe (session ids end up in URLs / file paths / logs).
      expect(leftId).not.toMatch(/[#@/]/);
      expect(rightId).not.toMatch(/[#@/]/);
    }
  });
});

describe("workflow driver — resume 会话身份互证", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  function driverWith(journal: InMemoryJournalStore, onFactory?: () => void) {
    const makeDriver = createAgentRuntimeWorkflowDriver({
      journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      runtimeFactory: () => {
        onFactory?.();
        // Minimal stub: once cross-checking passes, the driver only needs a runtime object it can hold.
        return {
          close: async () => {},
          executeTurn: async () => ({ response: "ok", events: [], usage: undefined }),
        } as never;
      },
    });
    return makeDriver(NOOP_SINK);
  }

  it("journal 记录的 sessionId 与铸造结果不一致时大声失败，且不构造 runtime", async () => {
    // The journal's session id is a record; the minting function is the authority (the spec's
    // Invariants). A mismatch means the minting rule has drifted (rename / second
    // implementation), whose consequences — rehydration reading the wrong session, detail pages
    // opening nonexistent sessions — sit far from the cause, so it must fail loudly at the first
    // step of remounting, carrying a structured mismatch (same shape as a hash mismatch).
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "sess_drifted-scheme",
    });

    let factoryCalls = 0;
    const driver = driverWith(journal, () => factoryCalls++);
    await expect(
      driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {}),
    ).rejects.toMatchObject({
      code: "DriverError",
      mismatch: {
        expected: "sess_drifted-scheme",
        got: mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 }),
      },
    });
    expect(factoryCalls).toBe(0);
  });

  it("journal 记录与铸造结果一致时正常重挂（同一个会话 id）", async () => {
    const minted = mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 });
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1, sessionId: minted });

    let factoryCalls = 0;
    const driver = driverWith(journal, () => factoryCalls++);
    await expect(driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {})).resolves.toEqual(
      {
        id: minted,
      },
    );
    expect(factoryCalls).toBe(1);
  });

  it("journal 无记录（全新 actor）时不做互证，正常建会话", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });

    const driver = driverWith(journal);
    await expect(driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {})).resolves.toEqual(
      {
        id: mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 }),
      },
    );
  });
});

// ————————————————————————————————————————————————————————————————
// The driver half of amend-resume: ask boundary bookkeeping + transcript truncation.
// See apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, the "Amend-resume" and
// "Transcript truncation (driver)" lines.
//
// These two families **must run against a real store**: what is under test is precisely "are the
// counted and the copied messages the same batch", and messages only truly persist once wired to
// a real session store. A stub returning fixed numbers would replace the semantics under test
// with a replica.
// ————————————————————————————————————————————————————————————————

/** One-shot sqlite session store (real persistence layer), deleted after use. */
async function withSessionStore(run: (store: SessionStorePort) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dwf-transcript-"));
  const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
  try {
    await run(store as unknown as SessionStorePort);
  } finally {
    (store as unknown as { close(): void }).close();
    await rm(root, { force: true, recursive: true });
  }
}

/** Poll until a condition holds (fire-and-forget startAsk has no awaitable handle). */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TWO_ASK_SCRIPT = [
  "interface A { text: string }",
  'const w = agent("worker", "You work.");',
  'const a = await w.ask<A>("first question");',
  'const b = await w.ask<A>("second question");',
  "return `${a.text}/${b.text}`;",
].join("\n");

const ACTOR_ONE: ActorRef = { siteId: "actor#1", ordinal: 1 };

describe("workflow driver — ask 边界记账", () => {
  it("每个 ask 结算后写下该 actor 会话的消息数，第二个 ask 的边界更大", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-boundary";
      const { settlement, journal } = await runDriverScript(TWO_ASK_SCRIPT, {
        runId,
        sessionStore: store,
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
      });
      expect(settlement).toEqual({ status: "completed", artifact: "one/two" });

      const first = journal.getNode(runId, "ask#1", 1);
      const second = journal.getNode(runId, "ask#2", 1);
      // The boundary is a length counted through **one and the same access surface**: driver
      // counting, seed copying, and core's rehydration all read `sessionStore.messages`; the three
      // must agree, or the same N has different lengths in two readers' eyes.
      const persisted = await store.messages({
        sessionID: mintActorSessionId(runId, ACTOR_ONE),
      });
      expect(second?.messageBoundary).toBe(persisted.length);
      expect(first?.messageBoundary).toBeGreaterThan(0);
      expect(second?.messageBoundary).toBeGreaterThan(first?.messageBoundary ?? 0);

      // Read-modify-write (same family as stats backfill): not one engine-written field may be lost.
      expect(first).toMatchObject({
        status: "completed",
        actorSeq: 0,
        inputHash: inputHash("first question"),
        result: { text: "one" },
      });
      expect(first?.stats?.tokens).toBeGreaterThan(0);
      expect(second?.actorSeq).toBe(1);
      expect(second?.stats?.tokens).toBeGreaterThan(0);
    });
  }, 30_000);

  it("多 actor 各数各的会话（边界不串台）", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-boundary-multi";
      const script = [
        "interface A { text: string }",
        'const a = agent("a", "You are A.");',
        'const b = agent("b", "You are B.");',
        'const one = await a.ask<A>("a-first");',
        'const other = await b.ask<A>("b-only");',
        'const two = await a.ask<A>("a-second");',
        "return `${one.text}${other.text}${two.text}`;",
      ].join("\n");
      const answer: { kind: "submit"; result: { text: string } } = {
        kind: "submit",
        result: { text: "x" },
      };
      const { settlement, journal } = await runDriverScript(script, {
        runId,
        sessionStore: store,
        actorScripts: { "actor#1@1": [answer, answer], "actor#2@1": [answer] },
      });
      expect(settlement.status).toBe("completed");

      const aFirst = journal.getNode(runId, "ask#1", 1)?.messageBoundary;
      const bOnly = journal.getNode(runId, "ask#2", 1)?.messageBoundary;
      const aSecond = journal.getNode(runId, "ask#3", 1)?.messageBoundary;
      // b was asked only once, so its boundary must stop at its own turn — not grow along with a's.
      expect(bOnly).toBe(aFirst);
      // The first ask also persists a date announcement, so each ask adds a different number of entries; boundaries are checked against each session's actual counts.
      const aPersisted = await store.messages({
        sessionID: mintActorSessionId(runId, { siteId: "actor#1", ordinal: 1 }),
      });
      expect(aSecond).toBeGreaterThan(aFirst ?? 0);
      expect(aSecond).toBe(aPersisted.length);
      const bPersisted = await store.messages({
        sessionID: mintActorSessionId(runId, { siteId: "actor#2", ordinal: 1 }),
      });
      expect(bOnly).toBe(bPersisted.length);
    });
  }, 30_000);

  it("无转录存取面时不写边界（既有装配原样不变）", async () => {
    const runId = "dwfrun-no-store";
    const { journal } = await runDriverScript(TWO_ASK_SCRIPT, {
      runId,
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { text: "one" } },
          { kind: "submit", result: { text: "two" } },
        ],
      },
    });
    // Absent means absent: write neither 0 nor a guessed value. The cost is that this run cannot serve as a revision predecessor (the service-side gate blocks it).
    expect(journal.getNode(runId, "ask#1", 1)?.messageBoundary).toBeUndefined();
    expect(journal.getNode(runId, "ask#2", 1)?.status).toBe("completed");
  }, 30_000);
});

describe("workflow driver — 转录截断（会话种子）", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  /** Run a source run once, leaving behind a real transcript + its boundary bookkeeping. */
  async function recordSourceRun(
    store: SessionStorePort,
    runId: string,
  ): Promise<{ boundaries: number[]; sessionId: SessionId }> {
    const { settlement, journal } = await runDriverScript(TWO_ASK_SCRIPT, {
      runId,
      sessionStore: store,
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { text: "one" } },
          { kind: "submit", result: { text: "two" } },
        ],
      },
    });
    expect(settlement.status).toBe("completed");
    return {
      boundaries: [
        journal.getNode(runId, "ask#1", 1)?.messageBoundary ?? 0,
        journal.getNode(runId, "ask#2", 1)?.messageBoundary ?? 0,
      ],
      sessionId: mintActorSessionId(runId, ACTOR_ONE),
    };
  }

  /** Transcript surface that counts writes (the idempotency case's observation point: skipping the copy = zero writes). */
  function countingTranscriptStore(store: SessionStorePort): {
    store: ActorTranscriptStore;
    writes: { messages: number; parts: number };
  } {
    const writes = { messages: 0, parts: 0 };
    return {
      writes,
      store: {
        messages: (input) => store.messages(input),
        saveMessage: async (message) => {
          writes.messages++;
          await store.saveMessage(message);
        },
        savePart: async (part) => {
          writes.parts++;
          await store.savePart(part);
        },
      },
    };
  }

  /** Amendment-run driver: real runtime (on a real store) + records the seeds and model requests the factory received. */
  function amendDriver(input: {
    journal: InMemoryJournalStore;
    runId: string;
    store: SessionStorePort;
    transcriptStore?: ActorTranscriptStore;
  }) {
    const seeds: (ActorSessionSeed | undefined)[] = [];
    const requests: ModelRequest[] = [];
    const fileSystemPort = fakeFileSystemPort({});
    const driver = createAgentRuntimeWorkflowDriver({
      journal: input.journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      executionPort: unsupportedExecutionPort(),
      fileSystemPort,
      cwd: process.cwd(),
      runId: input.runId,
      actorTranscriptStore: input.transcriptStore ?? input.store,
      runtimeFactory: async ({ actor, persona, seed, sessionId, submitPort }) => {
        seeds.push(seed);
        const runtime = createTestAgentRuntime(
          sessionId,
          {
            systemPrompt: persona.system ?? "You are a workflow actor.",
            mode: "yolo",
            taskType: "workflow_child",
            subagents: { enabled: false },
            ...workflowActorToolPolicy(persona),
          },
          {
            eventStore: createInMemorySessionEventStore(),
            modelAdapter: {
              async generateText(request: ModelRequest) {
                requests.push(request);
                return {
                  finishReason: "stop",
                  model: "scripted",
                  providerMetadata: undefined,
                  text: "ok",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              },
            } as never,
            workflowSubmitPort: submitPort,
            fileSystemPort,
            sessionStore: input.store,
          },
        );
        // Mirrors production (persistActorSession): the session row lands first, so the copy has an FK to attach to.
        await runtime.ensureSessionPersistedForExternalActivity(
          `workflow actor ${refToString(actor)}`,
        );
        return runtime;
      },
    })(NOOP_SINK);
    return { driver, requests, seeds };
  }

  function journalFor(runId: string): InMemoryJournalStore {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    return journal;
  }

  it("按边界复制源会话前缀进新铸会话，且前驱转录一字不动", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src");
      const sourceMessages = await store.messages({ sessionID: source.sessionId });
      const amendRunId = "dwfrun-amend";
      const { driver, seeds } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      // First ask hits the cache, second diverges: the seed = the first ask's boundary.
      const ref = await driver.createActorSession(
        ACTOR_ONE,
        { name: "worker" },
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
          resolvedModel: "anthropic/some-model",
        },
      );

      // The new session id is minted as usual (mint rules unchanged); it is not the source session.
      expect(ref.id).toBe(mintActorSessionId(amendRunId, ACTOR_ONE));
      expect(ref.id).not.toBe(source.sessionId);

      const copied = await store.messages({ sessionID: ref.id as SessionId });
      expect(copied).toHaveLength(source.boundaries[0]!);
      expect(copied.map((m) => m.info.role)).toEqual(
        sourceMessages.slice(0, source.boundaries[0]!).map((m) => m.info.role),
      );
      // Every one is a **copy**: ids must be new, or the upsert would move the predecessor's row into the new session.
      for (const [index, message] of copied.entries()) {
        expect(message.info.id).not.toBe(sourceMessages[index]!.info.id);
        expect(message.info.sessionID).toBe(ref.id);
        for (const part of message.parts) expect(part.sessionID).toBe(ref.id);
      }
      // The predecessor is read-only: the source session still has its original four messages, not one more or fewer, ids unchanged.
      const sourceAfter = await store.messages({ sessionID: source.sessionId });
      expect(sourceAfter.map((m) => m.info.id)).toEqual(sourceMessages.map((m) => m.info.id));

      // The seed reaches the runtime factory verbatim — the seam for pin inheritance (the launch side computes pinnedModel from it).
      expect(seeds).toEqual([
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
          resolvedModel: "anthropic/some-model",
        },
      ]);
    });
  }, 40_000);

  it("复制来的转录进入 runtime 上下文：分歧后的第一次模型请求带着它", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src2");
      const amendRunId = "dwfrun-amend2";
      const { driver, requests } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      const ref = await driver.createActorSession(
        ACTOR_ONE,
        { name: "worker" },
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
        },
      );

      // startAsk is fire-and-forget (Boundary B contract), so the observation surface is the model request itself.
      driver.startAsk(
        ref,
        { siteId: "ask#1", ordinal: 1 },
        {
          instructions: "continue from where we left off",
          typed: false,
        },
      );
      await waitFor(() => requests.length > 0);

      const conversation = JSON.stringify(requests[0]?.messages ?? []);
      // The source transcript's first question must be in the context — the whole point of full-fidelity truncation.
      expect(conversation).toContain("first question");
      expect(conversation).toContain("continue from where we left off");
      // The turn after the boundary is not (truncation, not a full copy).
      expect(conversation).not.toContain("second question");
    });
  }, 40_000);

  it("幂等：目标会话已有内容时不再复制（崩溃后重挂同一个会话 id）", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src3");
      const amendRunId = "dwfrun-amend3";
      const journal = journalFor(amendRunId);
      const seed: ActorSessionSeed = {
        sourceSessionId: source.sessionId,
        messageCount: source.boundaries[0]!,
      };

      const first = amendDriver({ journal, runId: amendRunId, store });
      const ref = await first.driver.createActorSession(ACTOR_ONE, { name: "worker" }, seed);
      const afterFirst = await store.messages({ sessionID: ref.id as SessionId });
      expect(afterFirst).toHaveLength(seed.messageCount);

      // Remount: the session id is purely determined by (runId, actorRef), so the second minting
      // yields the same one, already holding the previous incarnation's "copied + newly produced"
      // content. Copying again would double the context — so this time not one word may be written.
      journal.putActor({ ...ACTOR_ONE, runId: amendRunId, sessionId: ref.id });
      const counting = countingTranscriptStore(store);
      const second = amendDriver({
        journal,
        runId: amendRunId,
        store,
        transcriptStore: counting.store,
      });
      await second.driver.createActorSession(ACTOR_ONE, { name: "worker" }, seed);

      expect(counting.writes).toEqual({ messages: 0, parts: 0 });
      const afterSecond = await store.messages({ sessionID: ref.id as SessionId });
      expect(afterSecond.map((m) => m.info.id)).toEqual(afterFirst.map((m) => m.info.id));
    });
  }, 40_000);

  it("源会话不存在或短于边界 → 结构化大声失败", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src4");
      const amendRunId = "dwfrun-amend4";

      const missing = amendDriver({ journal: journalFor(amendRunId), runId: amendRunId, store });
      await expect(
        missing.driver.createActorSession(
          ACTOR_ONE,
          { name: "worker" },
          {
            sourceSessionId: "sess_never-existed",
            messageCount: 2,
          },
        ),
      ).rejects.toMatchObject({ code: "DriverError", mismatch: { expected: "2", got: "0" } });

      const short = amendDriver({
        journal: journalFor("dwfrun-amend4b"),
        runId: "dwfrun-amend4b",
        store,
      });
      const tooFar = source.boundaries[1]! + 1;
      await expect(
        short.driver.createActorSession(
          ACTOR_ONE,
          { name: "worker" },
          {
            sourceSessionId: source.sessionId,
            messageCount: tooFar,
          },
        ),
      ).rejects.toMatchObject({
        code: "DriverError",
        mismatch: { expected: String(tooFar), got: String(source.boundaries[1]) },
      });
    });
  }, 40_000);

  it("无种子 → 全新空会话（byte-for-byte 今天的行为）", async () => {
    await withSessionStore(async (store) => {
      await recordSourceRun(store, "dwfrun-src5");
      const amendRunId = "dwfrun-fresh";
      const { driver, seeds } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      const ref = await driver.createActorSession(ACTOR_ONE, { name: "worker" });

      expect(seeds).toEqual([undefined]);
      expect(await store.messages({ sessionID: ref.id as SessionId })).toHaveLength(0);
    });
  }, 40_000);
});

// ── Ask quality epilogues (docs/dynamic-workflow/authoring.md "Each ask") ──
//
// Every ask's instructions are followed by a content standard; when typed, the schema epilogue
// follows immediately. Both are appended after the scheduler computes inputHash, so cache
// identity is unchanged — this also pins the journal's inputHash to the original instructions.
describe("workflow driver — quality epilogue on every ask", () => {
  const STANDARD = "Standard for this result:";

  it("typed ask: instructions, then the standard, then the schema epilogue", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: valid }] },
    });
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    const instructions = prompt.indexOf("Summarize the repo");
    const standard = prompt.indexOf(STANDARD);
    const schema = prompt.indexOf("call the `submit_result` tool to submit your final result");
    expect(instructions).toBeGreaterThanOrEqual(0);
    expect(instructions).toBeLessThan(standard);
    expect(standard).toBeLessThan(schema);
    expect(prompt).toContain("A check counts as passed only if you ran it during this ask.");
    // Addendum 2026-09-08: the default tier also requires running the check at the scale the ask names — a stand-in does not count.
    expect(prompt).toContain("Run the check the ask names, at the scale it names.");
    expect(prompt).toContain("call `escalate` instead of inventing a value");
    // The schema has no evidence / confidence fields: neither line appears.
    expect(prompt).not.toContain("`evidence` field");
    expect(prompt).not.toContain("Rate `confidence`");
  });

  it("untyped ask: instructions then the standard, no schema epilogue", async () => {
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("What is 2 + 2?");',
      "return answer;",
    ].join("\n");
    const { modelCalls, settlement } = await runDriverScript(script, {
      actorScripts: { "actor#1@1": [{ kind: "text", text: "4" }] },
    });
    expect(settlement.status).toBe("completed");
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    expect(prompt.indexOf("What is 2 + 2?")).toBeLessThan(prompt.indexOf(STANDARD));
    expect(prompt).not.toContain("submit_result");
  });

  it("names the evidence and confidence fields when the schema declares them", async () => {
    const script = [
      "interface Finding { where: string; evidence: string; confidence: number; }",
      'const worker = agent("worker");',
      'const f = await worker.ask<Finding>("Find the bug");',
      "return f;",
    ].join("\n");
    const { modelCalls } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { where: "a.ts:1", evidence: "read it", confidence: 0.5 } },
        ],
      },
    });
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    expect(prompt).toContain("Put each finding's citation in its `evidence` field.");
    expect(prompt).toContain("Rate `confidence` honestly");
  });

  it("nudge prompts carry no epilogue and the journaled inputHash ignores it", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { modelCalls, journal } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "text", text: "no submit yet" },
          { kind: "submit", result: valid },
        ],
      },
    });
    const prompts = modelCalls["actor#1@1"]?.prompts ?? [];
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain(STANDARD);
    expect(prompts[1]).not.toContain(STANDARD);
    expect(prompts[1]).toContain("You ended your turn without submitting a result.");
    // Cache identity = the hash of the original instructions, independent of the epilogue.
    expect(journal.getNode(RUN, "ask#1", 1)?.inputHash).toBe(inputHash("Summarize the repo"));
  });

  // docs/dynamic-workflow/transcript-and-notifications.md: the GUI folds the epilogue, and the
  // driver marks the boundary — it is the one assembling this text. The boundary persists with
  // the user message metadata (the full text stays in the text part; model history and transcript
  // copying are unchanged); a nudge turn is entirely engine text, so the boundary is 0.
  it("marks where the epilogue starts on the persisted user message; nudge is all epilogue", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-epilogue-fold";
      const valid = { title: "Repo", points: ["x"] };
      await runDriverScript(TYPED_ASK_SCRIPT, {
        runId,
        sessionStore: store,
        actorScripts: {
          "actor#1@1": [
            { kind: "text", text: "no submit yet" },
            { kind: "submit", result: valid },
          ],
        },
      });
      const persisted = await store.messages({ sessionID: mintActorSessionId(runId, ACTOR_ONE) });
      // model-only context announcements (like date) are not ask messages and carry no epilogue marker.
      const users = persisted.filter(
        (message) =>
          message.info.role === "user" && message.info.semantics?.kind !== "system_reminder",
      );
      expect(users.length).toBe(2);
      const askText = users[0]?.parts.find((part) => part.type === "text");
      expect(askText?.type === "text" ? askText.text : "").toContain(STANDARD);
      expect(users[0]?.info.metadata?.epilogueStart).toBe("Summarize the repo".length);
      expect(users[1]?.info.metadata?.epilogueStart).toBe(0);
    });
  }, 30_000);
});

// ————————————————————————————————————————————————————————————————
// Actor runtime finalization after run settlement (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
// The engine calls driver.dispose exactly once after run-settled; the driver runs each actor
// runtime through the same chain the app uses to close a session (closeBrowserSession), and a
// session with an in-flight turn waits for it to land before closing.
// ————————————————————————————————————————————————————————————————

describe("workflow driver — 结算后释放 actor runtime", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  /** Stub runtime: executeTurn rejects on abort (simulating a cancelled in-flight turn); closeBrowserSession is spiable. */
  function stubRuntime(close: () => Promise<void> = async () => {}) {
    const closeBrowserSession = vi.fn(close);
    const executeTurn = vi.fn(
      (_input: string, _b: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("workflow ask cancelled")),
            {
              once: true,
            },
          );
        }),
    );
    return {
      closeBrowserSession,
      executeTurn,
      close: async () => {
        await Promise.allSettled(executeTurn.mock.results.map((result) => result.value));
        await closeBrowserSession();
      },
    };
  }

  function driverWith(
    runtimes: Record<string, ReturnType<typeof stubRuntime>>,
    logger?: { warn: (message: string, context?: Record<string, unknown>) => void },
  ) {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    const makeDriver = createAgentRuntimeWorkflowDriver({
      journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      ...(logger === undefined ? {} : { logger: logger as never }),
      runtimeFactory: ({ actor }) => runtimes[refToString(actor)] as never,
    });
    return makeDriver(NOOP_SINK);
  }

  const A1: ActorRef = { siteId: "actor#1", ordinal: 1 };
  const A2: ActorRef = { siteId: "actor#2", ordinal: 1 };
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("创建 actor 尚未返回时关闭，等待迟到实例释放且不再接收新 actor", async () => {
    const factory = Promise.withResolvers<ReturnType<typeof stubRuntime>>();
    const cleanup = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const runtime = stubRuntime(async () => {
      released.resolve();
      await cleanup.promise;
    });
    let probe!: { drain(): Promise<void> };
    const driver = createAgentRuntimeWorkflowDriver({
      journal: new InMemoryJournalStore(),
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      runtimeFactory: async () => (await factory.promise) as never,
      onQuiescenceProbe: (value) => {
        probe = value;
      },
    })(NOOP_SINK);
    const creating = driver.createActorSession(A1, {});
    const rejected = expect(creating).rejects.toThrow(/closed/);
    driver.dispose?.();
    let drained = false;
    const draining = probe.drain().then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(drained).toBe(false);
    factory.resolve(runtime);
    await released.promise;
    expect(drained).toBe(false);
    cleanup.resolve();
    await rejected;
    await draining;
    expect(runtime.closeBrowserSession).toHaveBeenCalledTimes(1);
    await expect(driver.createActorSession(A2, {})).rejects.toThrow(/closed/);
  });

  it("无在飞 turn 的会话立即关；有在飞 turn 的会话等 turn 落地后才关", async () => {
    const idle = stubRuntime();
    const busy = stubRuntime();
    const driver = driverWith({ "actor#1@1": idle, "actor#2@1": busy });
    await driver.createActorSession(A1, {});
    const s2 = await driver.createActorSession(A2, {});
    const instance = { siteId: "ask#1", ordinal: 1 };
    driver.startAsk(s2, instance, { instructions: "go", typed: false });
    expect(busy.executeTurn).toHaveBeenCalledTimes(1);

    // Engine settlement: cancelAsk first (aborts the in-flight ask), then dispose — matching engine.cancel / complete's order.
    driver.cancelAsk(instance);
    driver.dispose?.();
    expect(idle.closeBrowserSession).not.toHaveBeenCalled(); // still queued behind Promise.resolve().then
    await flushMicrotasks();
    expect(idle.closeBrowserSession).toHaveBeenCalledTimes(1);
    expect(busy.closeBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("在飞 turn 未落地前不关它的 runtime（等待是载荷性的：askStats 在 settle 之后才到）", async () => {
    const busy = stubRuntime();
    // This stub's turn does not respond to abort: simulates a turn still finalizing.
    busy.executeTurn.mockImplementation(() => new Promise(() => {}));
    const driver = driverWith({ "actor#1@1": busy });
    const s1 = await driver.createActorSession(A1, {});
    driver.startAsk(s1, { siteId: "ask#1", ordinal: 1 }, { instructions: "go", typed: false });

    driver.dispose?.();
    await flushMicrotasks();
    expect(busy.closeBrowserSession).not.toHaveBeenCalled();
  });

  it("幂等：dispose 两次，每个 runtime 只关一次", async () => {
    const r = stubRuntime();
    const driver = driverWith({ "actor#1@1": r });
    await driver.createActorSession(A1, {});
    driver.dispose?.();
    driver.dispose?.();
    await flushMicrotasks();
    expect(r.closeBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("关闭失败只 warn（带 sessionId），结算不因它抛", async () => {
    const r = stubRuntime(async () => {
      throw new Error("browser backend gone");
    });
    const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const driver = driverWith(
      { "actor#1@1": r },
      { warn: (message, context) => warns.push({ message, context }) },
    );
    await driver.createActorSession(A1, {});
    expect(() => driver.dispose?.()).not.toThrow();
    await flushMicrotasks();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context).toMatchObject({
      errorMessage: "browser backend gone",
      event: "dynamic_workflow.actor_runtime.close_failed",
      sessionId: mintActorSessionId(RUN, A1),
    });
  });

  it("真实管线：run 结算后每个 actor runtime 关闭链恰好一次，且 runtime 可被 GC 回收", async () => {
    const script = [
      "interface A { text: string }",
      'const w1 = agent("w1", "You work.");',
      'const w2 = agent("w2", "You also work.");',
      'const [a, b] = await Promise.all([w1.ask<A>("first"), w2.ask<A>("second")]);',
      "return `${a.text}/${b.text}`;",
    ].join("\n");

    // The counters avoid vi.spyOn: the spy registry is module-level and would root the spied
    // instances, defeating the GC assertion. The wrappers attach only to the instances
    // themselves, with no external reference to the runtime.
    const closes = new Map<string, number>();
    const refs = new Map<string, WeakRef<object>>();
    const { settlement } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [{ kind: "submit", result: { text: "A" } }],
        "actor#2@1": [{ kind: "submit", result: { text: "B" } }],
      },
      onRuntimeCreated: (runtime, key) => {
        closes.set(key, 0);
        const original = runtime.closeBrowserSession.bind(runtime);
        (runtime as { closeBrowserSession: () => Promise<void> }).closeBrowserSession = () => {
          closes.set(key, (closes.get(key) ?? 0) + 1);
          return original();
        };
        refs.set(key, new WeakRef(runtime));
      },
    });
    expect(settlement).toEqual({ status: "completed", artifact: "A/B" });
    expect([...closes.keys()].sort()).toEqual(["actor#1@1", "actor#2@1"]);

    // The close chain runs only after the turn lands (on the accept path stats trail settle, and the turn's finalization still awaits persistence): poll for it.
    await waitFor(() => [...closes.values()].every((count) => count >= 1));
    for (const [key, count] of closes) expect(count, key).toBe(1);

    // GC collectability: after a forced full GC, no root still holds an actor runtime.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (
      let round = 0;
      round < 3 && [...refs.values()].some((ref) => ref.deref() !== undefined);
      round++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    for (const [key, ref] of refs) expect(ref.deref(), `${key} 仍被某个根引用`).toBeUndefined();
  });
});
