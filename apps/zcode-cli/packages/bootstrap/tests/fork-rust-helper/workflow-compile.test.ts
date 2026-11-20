import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
} from "@zcode/contracts";
import { builtInTools } from "@zcode/core";
import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";
import {
  FORK_RUST_HELPER_METHODS,
  FORK_RUST_HELPER_PROTOCOL_VERSION,
  runForkRustHelper,
} from "../../src/fork-rust-helper/contract.js";

// specs/fork-rust-workflow-engine.md, section 4.1 (as built, W4): the stateless compile and format
// methods the Rust agent calls over the helper link. The helper never touches storage for them.

interface Frame {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startHelper() {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-workflow-compile-"));
  dirs.push(cwd);
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<string, (frame: Frame) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (frame.id !== undefined && pending.has(String(frame.id))) {
      pending.get(String(frame.id))!(frame);
      pending.delete(String(frame.id));
    }
  });
  const done = runForkRustHelper({ input, output, env: process.env, cwd });
  let next = 0;
  return {
    done,
    request(method: string, params: unknown): Promise<Frame> {
      next += 1;
      const id = `wf-${next}`;
      const reply = new Promise<Frame>((resolve) => pending.set(id, resolve));
      input.write(`${JSON.stringify({ id, method, params })}\n`);
      return reply;
    },
    close() {
      input.end();
    },
  };
}

const VALID_SCRIPT = [
  'const reviewer = agent("reviewer");',
  'const answer = await reviewer.ask("Say hello.");',
  "return answer;",
].join("\n");

const BROKEN_SCRIPT = 'const count: number = "not a number";\nreturn count;';

describe("fork: helper/workflow/compile and helper/workflow/format (W4)", () => {
  it("advertises both methods in helper/initialize", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/initialize", {
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.methods).toEqual([...FORK_RUST_HELPER_METHODS]);
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/compile");
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/format");
    helper.close();
    await helper.done;
  });

  it("compiles a valid script: scriptHash is the SHA-256 of the author's text and the entry is rendered", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: VALID_SCRIPT,
      runId: "run-w4-1",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      scriptHash: string;
      compiled: Record<string, unknown>;
      entrySource: string;
    };
    expect(result.ok).toBe(true);
    expect(result.scriptHash).toBe(createHash("sha256").update(VALID_SCRIPT, "utf8").digest("hex"));
    // The lowered body travels inside entrySource only; the compile result carries the rest.
    expect(result.compiled).not.toHaveProperty("lowered");
    expect(Object.keys(result.compiled)).toEqual(
      expect.arrayContaining([
        "askSpecs",
        "actorSubmitProfiles",
        "sitePhases",
        "phases",
        "holes",
        "holeBodies",
        "scriptHash",
      ]),
    );
    expect(result.entrySource).toContain('"id":"run-w4-1"');
    expect(result.entrySource).toContain("export const payload");
    helper.close();
    await helper.done;
  });

  it("answers the compile's Map tables as JSON objects, so a script with an ask site carries them (9.37, 333)", async () => {
    const helper = await startHelper();
    // A phase declaration gives the site a phase, so the phase table is not empty.
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: ['phase("Work");', VALID_SCRIPT].join("\n"),
      runId: "run-w4-maps",
    });
    expect(reply.error).toBeUndefined();
    const compiled = (reply.result as { compiled: Record<string, unknown> }).compiled;
    // Node's askSpecs and sitePhases are JS Maps; JSON.stringify writes a Map as {}, so these must be plain objects.
    const askSpecs = compiled.askSpecs as Record<string, { typed: unknown }>;
    expect(Object.keys(askSpecs).length).toBeGreaterThan(0);
    for (const spec of Object.values(askSpecs)) expect(typeof spec.typed).toBe("boolean");
    const sitePhases = compiled.sitePhases as Record<string, unknown>;
    expect(Object.keys(sitePhases).length).toBeGreaterThan(0);
    for (const phase of Object.values(sitePhases)) expect(typeof phase).toBe("string");
    helper.close();
    await helper.done;
  });

  it("passes resumedFrom into the run identity of the rendered entry", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: VALID_SCRIPT,
      runId: "run-w4-2",
      resumedFrom: "run-w4-0",
    });
    const result = reply.result as { ok: boolean; entrySource: string };
    expect(result.ok).toBe(true);
    expect(result.entrySource).toContain('"resumedFrom":"run-w4-0"');
    helper.close();
    await helper.done;
  });

  it("answers a script with type errors as ok false with positioned diagnostics and no entry", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", {
      scriptText: BROKEN_SCRIPT,
      runId: "run-w4-3",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      diagnostics: { code: number; line: number; column: number; message: string }[];
      entrySource?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        line: expect.any(Number),
        column: expect.any(Number),
        message: expect.any(String),
      }),
    );
    expect(result.entrySource).toBeUndefined();
    helper.close();
    await helper.done;
  });

  it("refuses a compile without a runId as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/compile", { scriptText: VALID_SCRIPT });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });

  it("formats the analysis of a script as the JSON of analyzeWorkflowScript", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "analysis",
      scriptText: VALID_SCRIPT,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      analysis: JSON.parse(JSON.stringify(analyzeWorkflowScript(VALID_SCRIPT))),
    });
    helper.close();
    await helper.done;
  });

  it("refuses a format kind it does not serve as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "runText",
      scriptText: VALID_SCRIPT,
    });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });
});

// W7-2 (specs/fork-rust-workflow-engine.md, 9.17): the run list, the run detail and the window display come from Node's own
// tool entries, found in `builtInTools`. The helper runs Node's handler and formatter, so each expectation is computed by Node.

type NodeToolEntry = {
  metadata: { name: string };
  handler: (input: unknown, context: unknown) => Promise<unknown>;
  formatModelContent?: (output: unknown) => unknown;
  prepareApproval?: (input: unknown) => { gate: string; display?: unknown };
};

function nodeEntry(name: string): NodeToolEntry {
  const entry = (builtInTools as unknown as NodeToolEntry[]).find(
    (tool) => tool.metadata.name === name,
  );
  if (entry === undefined) throw new Error(`Node has no tool ${name}`);
  return entry;
}

const FORMAT_NOW = Date.UTC(2026, 7, 21, 9, 5, 40);
const FORMAT_WORKDIR = "/work/project";

const LIST_ROW = {
  runId: "dwfrun-running",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  spentTokens: 1204,
};

const RUN_DETAIL = {
  runId: "dwfrun-running",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  usage: {
    spentTokens: 1204,
    nodesObserved: 3,
    nodesRunning: 1,
    nodesCompleted: 2,
    nodesFailed: 0,
  },
  actors: [{ siteId: "agent#1", ordinal: 1, name: "judge" }],
  logTail: [
    { sequence: 11, message: "collected the failing specs", at: Date.UTC(2026, 7, 21, 9, 0, 50) },
  ],
  subagents: [],
  health: {
    lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
};

describe("fork: helper/workflow/format run list, run detail and window display (W7-2)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FORMAT_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the run list exactly as Node's ListWorkflowRuns formatter", async () => {
    const listed = { runs: [LIST_ROW], truncated: false };
    const entry = nodeEntry(LIST_WORKFLOW_RUNS_TOOL_NAME);
    const port = { listRuns: async () => listed };
    const output = await entry.handler(
      {},
      { workingDirectory: FORMAT_WORKDIR, dynamicWorkflowRunPort: port },
    );
    const expected = entry.formatModelContent!(output);
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "runList",
      input: {},
      listed,
      workingDirectory: FORMAT_WORKDIR,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ text: expected });
    expect(String(expected)).toContain('<run id="dwfrun-running"');
    helper.close();
    await helper.done;
  });

  it("formats the run detail exactly as Node's GetWorkflowRun formatter, summary included", async () => {
    const entry = nodeEntry(GET_WORKFLOW_RUN_TOOL_NAME);
    const port = { getRunDetail: async () => RUN_DETAIL };
    const output = await entry.handler(
      { run_id: "dwfrun-running" },
      { workingDirectory: FORMAT_WORKDIR, dynamicWorkflowRunPort: port },
    );
    const expected = entry.formatModelContent!(output);
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "runDetail",
      runId: "dwfrun-running",
      detail: RUN_DETAIL,
      workingDirectory: FORMAT_WORKDIR,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ text: expected });
    expect(String(expected)).toContain("<summary>");
    helper.close();
    await helper.done;
  });

  it("returns the CreateWorkflow window display as Node's confirmation display", async () => {
    const expected = nodeEntry(CREATE_WORKFLOW_TOOL_NAME).prepareApproval!({
      script: VALID_SCRIPT,
    });
    expect(expected.gate).toBe("ask");
    expect(expected.display).toBeDefined();
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "display",
      scriptText: VALID_SCRIPT,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ display: JSON.parse(JSON.stringify(expected.display)) });
    helper.close();
    await helper.done;
  });

  it("answers null when Node asks for no window (a script that does not analyze)", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "display",
      scriptText: BROKEN_SCRIPT,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ display: null });
    helper.close();
    await helper.done;
  });

  it("refuses a run list without its listed rows as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", { kind: "runList", input: {} });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });

  // ocr finding (HIGH): Node's resolveInput writes model_bindings before prepareApproval, so a script that names a model
  // opens its window only with its bindings. The helper must thread them through.
  it("opens the window for a script that names a model only when its bindings are given", async () => {
    const MODEL_SCRIPT = [
      'const MODELS = { light: model("gpt-5") };',
      'const answer = await agent("answerer", { model: MODELS.light }).ask("go");',
      "return answer;",
    ].join("\n");
    const BINDINGS = { "gpt-5": "zhipu/gpt-5" };
    const withBindings = nodeEntry(CREATE_WORKFLOW_TOOL_NAME).prepareApproval!({
      script: MODEL_SCRIPT,
      model_bindings: BINDINGS,
    });
    expect(withBindings.gate).toBe("ask");
    expect(withBindings.display).toBeDefined();
    expect(
      nodeEntry(CREATE_WORKFLOW_TOOL_NAME).prepareApproval!({ script: MODEL_SCRIPT }).gate,
    ).toBe("proceed");
    const helper = await startHelper();
    const bound = await helper.request("helper/workflow/format", {
      kind: "display",
      scriptText: MODEL_SCRIPT,
      modelBindings: BINDINGS,
    });
    expect(bound.error).toBeUndefined();
    expect(bound.result).toEqual({ display: JSON.parse(JSON.stringify(withBindings.display)) });
    const unbound = await helper.request("helper/workflow/format", {
      kind: "display",
      scriptText: MODEL_SCRIPT,
    });
    expect(unbound.result).toEqual({ display: null });
    helper.close();
    await helper.done;
  });

  // ocr finding (MEDIUM): an unknown run must reach Node's own not-found failure. The helper answers its message as text.
  it("answers an unknown run with Node's not-found text", async () => {
    const entry = nodeEntry(GET_WORKFLOW_RUN_TOOL_NAME);
    const expected = (await entry.handler(
      { run_id: "dwfrun-gone" },
      {
        workingDirectory: FORMAT_WORKDIR,
        dynamicWorkflowRunPort: { getRunDetail: async () => undefined },
      },
    )) as { result: boolean; message: string };
    expect(expected.result).toBe(false);
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/format", {
      kind: "runDetail",
      runId: "dwfrun-gone",
      detail: null,
      workingDirectory: FORMAT_WORKDIR,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ text: expected.message });
    helper.close();
    await helper.done;
  });

  // ocr finding (LOW): members Node dereferences unconditionally are pinned, so drift is -32602, not a TypeError.
  it("refuses a run list whose runs are not an array, and a run detail without usage, as -32602", async () => {
    const helper = await startHelper();
    const badList = await helper.request("helper/workflow/format", {
      kind: "runList",
      input: {},
      listed: { runs: "none" },
      workingDirectory: FORMAT_WORKDIR,
    });
    expect(badList.error?.code).toBe(-32602);
    const { usage: _usage, ...withoutUsage } = RUN_DETAIL;
    void _usage;
    const badDetail = await helper.request("helper/workflow/format", {
      kind: "runDetail",
      runId: "dwfrun-running",
      detail: withoutUsage,
      workingDirectory: FORMAT_WORKDIR,
    });
    expect(badDetail.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });
});

// W7-8c (specs/fork-rust-workflow-engine.md, 9.28): EvalWorkflowSnippet's compile. The snippet facade declares no agent() and
// its world.run commands must be literals, as in Node's `dynamic-workflow-snippet-service.ts`. Nothing runs here.
// specs/fork-rust-workflow-engine.md, 9.45 (W7-12): one hole's fill, prepared on the helper. Nothing is written.
describe("fork: helper/workflow/fillPrepare (W7-12)", () => {
  const HOLE_SCRIPT = [
    'const reviewer = agent("reviewer");',
    'const verdict = await hole<string>("verdict", "decide on the answer");',
    "return verdict;",
  ].join("\n");

  it("advertises fillPrepare in helper/initialize", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/initialize", {
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
    });
    expect(reply.result?.methods).toContain("helper/workflow/fillPrepare");
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/fillPrepare");
    helper.close();
    await helper.done;
  });

  it("splices the body into the hole and returns its code and the effective script", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/fillPrepare", {
      scriptText: HOLE_SCRIPT,
      runId: "dwfrun-w712-1",
      holeId: "hole#1",
      body: "return 'approved';",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      code: string;
      effectiveText: string;
      scriptHash: string;
    };
    expect(result.ok).toBe(true);
    expect(result.code).toContain("approved");
    expect(result.effectiveText).toContain("approved");
    expect(result.effectiveText).not.toBe(HOLE_SCRIPT);
    expect(result.scriptHash.length).toBeGreaterThan(0);
    helper.close();
    await helper.done;
  });

  it("refuses a hole id that the script does not have, with Node's text and no effective script", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/fillPrepare", {
      scriptText: HOLE_SCRIPT,
      runId: "dwfrun-w712-2",
      holeId: "hole#9",
      body: "return 'x';",
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      ok: false,
      reason: "hole_not_waiting",
      message: expect.stringContaining("hole#9 is not a hole of run dwfrun-w712-2"),
    });
    helper.close();
    await helper.done;
  });
});

describe("fork: helper/workflow/evalSnippet (W7-8c)", () => {
  it("advertises evalSnippet in helper/initialize", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/initialize", {
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
    });
    expect(reply.result?.methods).toContain("helper/workflow/evalSnippet");
    expect(FORK_RUST_HELPER_METHODS).toContain("helper/workflow/evalSnippet");
    helper.close();
    await helper.done;
  });

  it("compiles a read-only snippet: ok, no world.run, and the entry is rendered for its run", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", {
      scriptText: "const total = [1, 2, 3].reduce((a, b) => a + b, 0);\nreturn total;",
      runId: "dwfeval-w78c-1",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as { ok: boolean; worldRun: boolean; entrySource: string };
    expect(result.ok).toBe(true);
    expect(result.worldRun).toBe(false);
    expect(result.entrySource).toContain('"id":"dwfeval-w78c-1"');
    expect(result.entrySource).toContain("export const payload");
    helper.close();
    await helper.done;
  });

  it("reports a literal world.run as worldRun true", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", {
      scriptText: 'const status = await world.run("git", ["status", "--short"]);\nreturn status;',
      runId: "dwfeval-w78c-2",
    });
    const result = reply.result as { ok: boolean; worldRun: boolean };
    expect(result.ok).toBe(true);
    expect(result.worldRun).toBe(true);
    helper.close();
    await helper.done;
  });

  it("refuses agent() in a snippet: the snippet facade has no actors, so the answer carries diagnostics and no entry", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", {
      scriptText: VALID_SCRIPT,
      runId: "dwfeval-w78c-3",
    });
    expect(reply.error).toBeUndefined();
    const result = reply.result as {
      ok: boolean;
      diagnostics: { code: number; line: number; column: number; message: string }[];
      entrySource?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.entrySource).toBeUndefined();
    helper.close();
    await helper.done;
  });

  it("answers a snippet with a type error as ok false with positioned diagnostics", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", {
      scriptText: BROKEN_SCRIPT,
      runId: "dwfeval-w78c-4",
    });
    const result = reply.result as { ok: boolean; diagnostics: { line: number }[] };
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.line).toEqual(expect.any(Number));
    helper.close();
    await helper.done;
  });

  it("refuses a non-literal world.run command with diagnostics, as the snippet service does", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", {
      scriptText:
        'function run(cmd: string) {\n  return world.run(cmd, []);\n}\nreturn run("git");',
      runId: "dwfeval-w78c-5",
    });
    const result = reply.result as { ok: boolean; diagnostics: unknown[]; entrySource?: string };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.entrySource).toBeUndefined();
    helper.close();
    await helper.done;
  });

  it("refuses a missing runId as -32602", async () => {
    const helper = await startHelper();
    const reply = await helper.request("helper/workflow/evalSnippet", { scriptText: "return 1;" });
    expect(reply.error?.code).toBe(-32602);
    helper.close();
    await helper.done;
  });
});
