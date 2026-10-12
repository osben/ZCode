/**
 * Run metadata is journaled through the **real entry point**: runWorkflowScript → engine construction → createRun.
 *
 * Unit tests that directly new WorkflowEngine (inside the dynamic-workflow package) only prove the engine writes these four fields;
 * this proves the harness really passes them down — dropping a single field along the way shows up as dwf_run columns being forever empty,
 * leaving the resume script_hash check with nothing to compare against.
 *
 * The harness deliberately does **not** compute scriptHash itself: the compile-once path passes `lowered` (at that point the harness
 * does not even hold the original script text); if the harness "conveniently" hashed the text it sees, that path would journal the hash of the
 * lowered function body — a silently wrong comparison target. Hashing belongs to the caller.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const RUN = "run";

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

describe("run metadata through the real entry point", () => {
  it("forwards scriptText / scriptHash / parentSessionId / cwd / toolCallId onto the journaled run record", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });

    const settlement = await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      // Caller-provided metadata: forwarded verbatim to EngineConfig; the harness does not process it.
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      toolCallId: "call-origin",
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const run = journal.getRun(RUN);
    expect(run).toMatchObject({
      runId: RUN,
      status: "completed",
      // scriptText stores the caller's original script text, not the lowered function body.
      scriptText: SCRIPT,
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      // The sole persistent source of the tool card join / resume notification anchor after a restart (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
      toolCallId: "call-origin",
    });
  });

  it("carries the run's subagent model on the journaled run-launched event, reasoning segment included", async () => {
    // The subagent model lives in `run-launched` with zero SQL (docs/dynamic-workflow/launch.md), riding the same vehicle as the launch anchor
    // and the phase table: the harness only forwards the whole launch block verbatim to EngineConfig — no reading, no parsing, no processing.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect(launched?.event).toEqual({
      type: "run-launched",
      inputId: "input-origin",
      // The reasoning-level segment travels as is: `$high` is part of the selection and the host reads the whole string back from this event.
      subagentModel: "zhipu/glm-5.3-flash$high",
    });
    // This fact is not on the row: it is not a dwf_run column (user ruling: no migration).
    expect("subagentModel" in journal.getRun(RUN)!).toBe(false);
  });

  it("omits subagentModel entirely when launch carries none", async () => {
    // Absence means "the subagent runs on the session model". Journaling a key with an undefined value would make the read side interpret "not set"
    // as "set to an empty model" — the two mean different things in AmendWorkflow's three states.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect("subagentModel" in launched!.event).toBe(false);
  });

  it("journals the authored scriptText, not the lowered body, when both are given", async () => {
    // The "compile once" shape: the caller compiles to lowered itself while also handing down the authored original. What gets journaled must be
    // the original — the two texts differ on purpose, so "conveniently substituting lowered" is caught by this assertion.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 7;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });

    expect(settlement).toEqual({ status: "completed", artifact: 7 });
    expect(journal.getRun(RUN)).toMatchObject({
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });
  });

  it("forwards the run name onto the journaled run record", async () => {
    // name travels the same metadata path as scriptText / cwd. Dropping this field in the harness shows up as dwf_run.name
    // being forever empty, leaving the host's enumeration surface to list bare runIds (the run introspection tool's label goes dead).
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      name: "nightly triage",
    });

    expect(journal.getRun(RUN)).toMatchObject({ name: "nightly triage" });
  });

  it("omits the metadata entirely when the caller passes none", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });

    const run = journal.getRun(RUN)!;
    for (const field of ["scriptText", "scriptHash", "parentSessionId", "name"]) {
      expect(field in run).toBe(false);
    }
  });

  it("rejects a resume whose scriptHash does not match the journaled one", async () => {
    // Proves end to end that this check now has a comparison target: the first pass journals a hash, and the second pass with a different hash is rejected.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });
    const base = {
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      timeoutMs: 20000,
    } as const;

    await runWorkflowScript({
    cwd: TEST_CWD,
      ...base,
      scriptText: SCRIPT,
      scriptHash: "hash-v1",
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
    });
    expect(journal.getRun(RUN)?.scriptHash).toBe("hash-v1");

    const resumed = new AutoDriver(journal, {});
    await expect(
      runWorkflowScript({
    cwd: TEST_CWD,
        ...base,
        scriptText: `${SCRIPT}\n// edited`,
        scriptHash: "hash-v2",
        makeDriver: (sink) => {
          resumed.attach(sink);
          return resumed;
        },
      }),
    ).rejects.toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-v1", got: "hash-v2" },
    });

    // A rejected resume must not rewrite the existing record (it can still be resumed with the hash-v1 script).
    expect(journal.getRun(RUN)).toMatchObject({ status: "completed", scriptHash: "hash-v1" });
  });
});
