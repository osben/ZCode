import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunFillHoleRequest,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type FillWorkflowHoleResult,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { collectSites, createWorkflowProgram } from "@zcode/dynamic-workflow";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createCreateWorkflowDisplay } from "../src/tool/executor/create-workflow-display.js";
import {
  FILL_WORKFLOW_HOLE_ERROR_CODE,
  fillWorkflowHoleToolEntry,
} from "../src/tool/handlers/fill-workflow-hole.js";
import { resetFillWorkflowHoleRejectionsForTests } from "../src/tool/handlers/fill-workflow-hole-resolve.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type {
  ToolExecutionContext,
  ToolHandlerFailure,
  ToolInputResolutionContext,
} from "../src/tool/types.js";

// docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool": resolveInput resolves run_id + hole_id into a
// `hole` facts block (ownership, name, type, draft path) → the permission service uses it to admit this session's
// run for free / ask as usual for others → the handler first writes the inline body into the fill file, then calls
// port.fillHole, with diagnostics anchored to "which file they landed in".

const BODY = 'const verdict = await agent("judge").ask<string>("judge it");\nreturn verdict;';
/** A valid script the port hands back on success: it compiles and carries one phase so both display and phasesAdded have content. */
const EFFECTIVE_SCRIPT = [
  'phase("判定");',
  'const verdict = await agent("judge").ask<string>("judge it");',
  "return verdict;",
].join("\n");

const CWD = mkdtempSync(join(tmpdir(), "dwf-fill-cwd-"));
afterAll(() => {
  rmSync(CWD, { force: true, recursive: true });
});

beforeEach(() => {
  resetFillWorkflowHoleRejectionsForTests();
});

function sessionOf(name: string): string {
  return createSessionId(name) as unknown as string;
}

const WAITING_HOLE = {
  siteId: "hole#1",
  ordinal: 1,
  name: "决定分组",
  type: "Verdict",
  state: "waiting" as const,
  since: 1_725_000_000_000,
  line: 12,
  before: "收集",
  after: "汇总",
};

interface StubPortOptions {
  snapshot?: Partial<DynamicWorkflowRunSnapshot>;
  fill?:
    | FillWorkflowHoleResult
    | ((request: DynamicWorkflowRunFillHoleRequest) => FillWorkflowHoleResult);
  /** The port has **no** fillHole (old host). */
  withoutFillHole?: boolean;
}

function stubRunPort(options: StubPortOptions = {}): {
  port: DynamicWorkflowRunPort;
  fills: DynamicWorkflowRunFillHoleRequest[];
  getTaskCalls: string[];
} {
  const fills: DynamicWorkflowRunFillHoleRequest[] = [];
  const getTaskCalls: string[] = [];
  const unreachable = (name: string) => () => {
    throw new Error(`stubRunPort.${name} 不应被 FillWorkflowHole 触及`);
  };
  return {
    port: {
      async getTask(taskId: string) {
        getTaskCalls.push(taskId);
        if (options.snapshot === undefined) return undefined;
        return {
          runId: taskId,
          taskId,
          startedAt: new Date(0),
          status: "running",
          ...options.snapshot,
        } as DynamicWorkflowRunSnapshot;
      },
      ...(options.withoutFillHole
        ? {}
        : {
            async fillHole(request: DynamicWorkflowRunFillHoleRequest) {
              fills.push(request);
              const fill = options.fill;
              if (fill === undefined) {
                return {
                  ok: true,
                  phasesAdded: ["判定"],
                  scriptPath: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
                  scriptText: EFFECTIVE_SCRIPT,
                };
              }
              return typeof fill === "function" ? fill(request) : fill;
            },
          }),
      submit: unreachable("submit"),
      waitForTask: unreachable("waitForTask"),
      cancel: unreachable("cancel"),
      listEvents: unreachable("listEvents"),
    } as unknown as DynamicWorkflowRunPort,
    fills,
    getTaskCalls,
  };
}

function resolutionContext(
  port: DynamicWorkflowRunPort | undefined,
  name: string,
  loaded = true,
): ToolInputResolutionContext {
  return {
    workingDirectory: CWD,
    sessionId: sessionOf(name),
    hasLoadedSkill: () => loaded,
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  };
}

async function resolve(input: unknown, context: ToolInputResolutionContext) {
  return fillWorkflowHoleToolEntry.resolveInput!(input, context);
}

function executionContext(
  port: DynamicWorkflowRunPort | undefined,
  name: string,
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: sessionOf(name) as never,
    toolCallId: `toolu_${name}`,
    traceId: `trace_${name}` as never,
    workingDirectory: CWD,
    workspaceRoot: CWD,
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  } as ToolExecutionContext;
}

function asFailure(value: unknown): ToolHandlerFailure {
  const failure = value as ToolHandlerFailure;
  expect(failure.result).toBe(false);
  return failure;
}

function fillFilesIn(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".dwf.ts"))
        .sort()
    : [];
}

describe("FillWorkflowHole — validateInput", () => {
  it("wants exactly one of script and path", () => {
    const validate = fillWorkflowHoleToolEntry.validateInput!;
    expect(validate({ run_id: "r", hole_id: "hole#1", script: BODY }, {})).toEqual({
      result: true,
    });
    const both = asFailure(
      validate({ run_id: "r", hole_id: "hole#1", script: BODY, path: "x" }, {}),
    );
    expect(both.message).toBe(FILL_WORKFLOW_HOLE_SOURCE_ERROR);
    const neither = asFailure(validate({ run_id: "r", hole_id: "hole#1" }, {}));
    expect(neither.message).toBe(FILL_WORKFLOW_HOLE_SOURCE_ERROR);
  });
});

describe("FillWorkflowHole — resolveInput", () => {
  it("refuses before touching the port when the skill is not loaded", async () => {
    const { port, getTaskCalls } = stubRunPort({ snapshot: { holes: [WAITING_HOLE] } });
    const failure = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
        resolutionContext(port, "gate", false),
      ),
    );
    expect(failure.message).toContain("dynamic-workflows");
    expect(failure.message).toContain(FILL_WORKFLOW_HOLE_TOOL_NAME);
    expect(getTaskCalls).toHaveLength(0);
  });

  it("fails run_not_found when the run does not exist", async () => {
    const { port } = stubRunPort();
    const failure = asFailure(
      await resolve(
        { run_id: "dwfrun-nope", hole_id: "hole#1", script: BODY },
        resolutionContext(port, "nf"),
      ),
    );
    expect(failure.message).toContain("run_not_found");
    expect(failure.message).toContain("dwfrun-nope");
  });

  it("refuses hole_not_waiting for an unknown, filled or stopped hole, naming the next step", async () => {
    const filled = { ...WAITING_HOLE, siteId: "hole#2", state: "filled" as const, filledAt: 5 };
    const { port } = stubRunPort({ snapshot: { holes: [WAITING_HOLE, filled] } });
    const unknown = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#9", script: BODY },
        resolutionContext(port, "unk"),
      ),
    );
    expect(unknown.message).toContain("hole_not_waiting");
    expect(unknown.message).toContain("hole#9");
    expect(unknown.errorCode).toBe(FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING);
    const already = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#2", script: BODY },
        resolutionContext(port, "already"),
      ),
    );
    expect(already.message).toContain("already filled");

    const stopped = stubRunPort({
      snapshot: {
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "user",
        holes: [WAITING_HOLE],
      },
    });
    const notInFlight = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
        resolutionContext(stopped.port, "stopped"),
      ),
    );
    expect(notInFlight.message).toContain("hole_not_waiting");
    expect(notInFlight.message).toContain("ResumeWorkflowRun");
  });

  it("backfills the hole block from the snapshot and overrides a forged one", async () => {
    const name = "owned";
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        scriptPath: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
        holes: [WAITING_HOLE],
      },
    });
    const resolved = await resolve(
      {
        run_id: "dwfrun-1",
        hole_id: "hole#1",
        script: BODY,
        hole: { name: "forged", type: "never", owned_by_this_session: true },
      },
      resolutionContext(port, name),
    );
    expect(resolved).toEqual({
      result: true,
      input: {
        run_id: "dwfrun-1",
        hole_id: "hole#1",
        script: BODY,
        hole: {
          name: "决定分组",
          type: "Verdict",
          draft_path: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
          line: 12,
          owned_by_this_session: true,
        },
      },
    });
  });

  it("marks another session's run as not owned", async () => {
    const { port } = stubRunPort({
      snapshot: { parentSessionId: "sess_other", holes: [WAITING_HOLE] },
    });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(port, "foreign"),
    );
    expect(resolved).toMatchObject({
      result: true,
      input: { hole: { owned_by_this_session: false } },
    });
    // A run with no recorded draft: `draft_path` is absent rather than an empty string.
    expect("draft_path" in (resolved as { input: { hole: object } }).input.hole).toBe(false);
  });

  it("reads a path fill into script and keeps the path; an unreadable file fails by name", async () => {
    const fillPath = join(CWD, "my-fill.dwf.ts");
    writeFileSync(fillPath, BODY);
    const { port } = stubRunPort({ snapshot: { holes: [WAITING_HOLE] } });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", path: "my-fill.dwf.ts" },
      resolutionContext(port, "path"),
    );
    expect(resolved).toMatchObject({ result: true, input: { script: BODY, path: fillPath } });

    const missing = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1", path: "nowhere.dwf.ts" },
        resolutionContext(port, "path-missing"),
      ),
    );
    expect(missing.message).toContain("nowhere.dwf.ts");
    expect(missing.errorCode).toBe(FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_FILE);
  });

  it("passes an inline fill through without a hole block when there is no port", async () => {
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(undefined, "noport"),
    );
    expect(resolved).toEqual({
      result: true,
      input: { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
    });
  });
});

describe("FillWorkflowHole — handler", () => {
  it("writes the inline fill to <slug>.<hole-slug>.dwf.ts BEFORE the port compiles, minting -2 on a resubmission", async () => {
    const draftsDir = join(CWD, WORKFLOW_DRAFTS_DIR);
    const seenAtCall: boolean[] = [];
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf("write"),
        scriptPath: join(draftsDir, "triage.dwf.ts"),
        holes: [WAITING_HOLE],
      },
      fill: () => {
        seenAtCall.push(existsSync(join(draftsDir, "triage.决定分组.dwf.ts")));
        return { ok: false, reason: "compile_failed", message: "no", diagnostics: [] };
      },
    });
    const context = executionContext(port, "write");
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(port, "write"),
    );
    await fillWorkflowHoleToolEntry.handler((resolved as { input: unknown }).input, context);
    expect(seenAtCall).toEqual([true]);
    expect(readFileSync(join(draftsDir, "triage.决定分组.dwf.ts"), "utf8")).toBe(BODY);

    await fillWorkflowHoleToolEntry.handler((resolved as { input: unknown }).input, context);
    expect(fillFilesIn(draftsDir)).toEqual(["triage.决定分组-2.dwf.ts", "triage.决定分组.dwf.ts"]);
  });

  it("on diagnostics leads with the fill file and anchors each line to the file it falls in", async () => {
    const draftsDir = join(CWD, WORKFLOW_DRAFTS_DIR);
    const { port, fills } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf("diag"),
        scriptPath: join(draftsDir, "review.dwf.ts"),
        holes: [WAITING_HOLE],
      },
      fill: {
        ok: false,
        reason: "compile_failed",
        message: "The effective script does not compile.",
        diagnostics: [
          {
            line: 2,
            column: 8,
            message: "Type 'number' is not assignable to type 'string'.",
            code: 2322,
            inFill: true,
          },
          {
            line: 30,
            column: 1,
            message: "Subagent name 'judge' is declared twice.",
            code: 9005,
            inFill: false,
          },
        ],
      },
    });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(port, "diag"),
    );
    const output = (await fillWorkflowHoleToolEntry.handler(
      (resolved as { input: unknown }).input,
      executionContext(port, "diag"),
    )) as CreateWorkflowOutput;

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      runId: "dwfrun-1",
      holeId: "hole#1",
      body: BODY,
      parentSessionId: sessionOf("diag"),
    });
    expect(output.ok).toBe(false);
    expect(output.diagnostics).toHaveLength(2);
    const fillFile = join(WORKFLOW_DRAFTS_DIR, "review.决定分组.dwf.ts");
    expect(
      output.response.startsWith(
        `The fill is saved at ${fillFile}. Edit that file in place and resubmit with \`path\`; do not paste it inline again.`,
      ),
    ).toBe(true);
    expect(output.response).toContain(
      `${fillFile}:L2:C8 Type 'number' is not assignable to type 'string'.`,
    );
    expect(output.response).toContain(
      `${join(WORKFLOW_DRAFTS_DIR, "review.dwf.ts")}:L30:C1 Subagent name 'judge' is declared twice.`,
    );
    // Diagnostics exist outside the function body: state that it is the run's recorded script, editing the draft is useless, and the way out is AmendWorkflow.
    expect(output.response).toContain("run's recorded script");
    expect(output.response).toContain("AmendWorkflow");
    expect(output.response).toContain("still waiting");
    expect("status" in output).toBe(false);
    // The compile feedback row is minted by CreateWorkflow's display builder, selected for this tool by its tool name.
    const display = createCreateWorkflowDisplay(FILL_WORKFLOW_HOLE_TOOL_NAME, output);
    expect(display?.kind).toBe("create_workflow");
    // The rejected row also needs a name: the feedback row's title must not degrade to a site id.
    expect(display?.fill).toMatchObject({ siteId: "hole#1", name: "决定分组" });
  });

  it("refuses fill_unchanged when a path resubmits the bytes of the last rejected attempt, without touching the port", async () => {
    const draftsDir = join(CWD, WORKFLOW_DRAFTS_DIR);
    const { port, fills } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf("unchanged"),
        scriptPath: join(draftsDir, "unchanged.dwf.ts"),
        holes: [WAITING_HOLE],
      },
      fill: {
        ok: false,
        reason: "compile_failed",
        message: "no",
        diagnostics: [{ line: 1, column: 1, message: "bad", code: 1, inFill: true }],
      },
    });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(port, "unchanged"),
    );
    await fillWorkflowHoleToolEntry.handler(
      (resolved as { input: unknown }).input,
      executionContext(port, "unchanged"),
    );
    expect(fills).toHaveLength(1);

    const fillFile = join(draftsDir, "unchanged.决定分组.dwf.ts");
    const again = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1", path: fillFile },
        resolutionContext(port, "unchanged"),
      ),
    );
    expect(again.message).toContain("fill_unchanged");
    expect(again.errorCode).toBe(FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNCHANGED);
    expect(fills).toHaveLength(1);

    // Changing a single byte lets it through.
    writeFileSync(fillFile, `${BODY}\n`);
    const edited = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", path: fillFile },
      resolutionContext(port, "unchanged"),
    );
    expect(edited).toMatchObject({ result: true });
  });

  it("a path fill mints nothing and is refused hole_not_waiting / fill_ids_unstable verbatim from the port", async () => {
    const draftsDir = join(CWD, WORKFLOW_DRAFTS_DIR);
    const before = fillFilesIn(draftsDir);
    const fillPath = join(CWD, "path-fill.dwf.ts");
    writeFileSync(fillPath, BODY);
    const { port } = stubRunPort({
      snapshot: { parentSessionId: sessionOf("pathfill"), holes: [WAITING_HOLE] },
      fill: {
        ok: false,
        reason: "fill_ids_unstable",
        message: "Site hole#1/ask#1 moved: host fault.",
      },
    });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", path: fillPath },
      resolutionContext(port, "pathfill"),
    );
    const failure = asFailure(
      await fillWorkflowHoleToolEntry.handler(
        (resolved as { input: unknown }).input,
        executionContext(port, "pathfill"),
      ),
    );
    expect(failure.message).toContain("fill_ids_unstable");
    expect(failure.message).toContain("Site hole#1/ask#1 moved: host fault.");
    expect(fillFilesIn(draftsDir)).toEqual(before);
  });

  it("on success names the phases added, the draft to edit, and carries the effective script's graph", async () => {
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf("ok"),
        scriptPath: join(CWD, WORKFLOW_DRAFTS_DIR, "ok.dwf.ts"),
        holes: [WAITING_HOLE],
      },
      fill: {
        ok: true,
        phasesAdded: ["判定", "复核"],
        scriptPath: join(CWD, WORKFLOW_DRAFTS_DIR, "ok.dwf.ts"),
        scriptText: EFFECTIVE_SCRIPT,
      },
    });
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      resolutionContext(port, "ok"),
    );
    const output = (await fillWorkflowHoleToolEntry.handler(
      (resolved as { input: unknown }).input,
      executionContext(port, "ok"),
    )) as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    // The block that names itself: the name comes from the resolved hole and travels with the output and display (the transcript does not store the fill's input args).
    expect(output.fill).toEqual({
      siteId: "hole#1",
      name: "决定分组",
      draftPath: join(CWD, WORKFLOW_DRAFTS_DIR, "ok.dwf.ts"),
      line: WAITING_HOLE.line,
    });
    expect(createCreateWorkflowDisplay(FILL_WORKFLOW_HOLE_TOOL_NAME, output)?.fill).toEqual(
      output.fill,
    );
    expect(output.diagnostics).toEqual([]);
    expect(output.response).toContain("joined run dwfrun-1");
    expect(output.response).toContain("决定分组");
    expect(output.response).toContain("判定, 复核");
    expect(output.response).toContain(`${join(WORKFLOW_DRAFTS_DIR, "ok.dwf.ts")}`);
    expect(output.response).toContain("AmendWorkflow");
    expect(output.causalityGraph?.steps).toHaveLength(1);
    expect(output.causalityGraph?.phases?.map((phase) => phase.name)).toEqual(["判定"]);
    expect("status" in output).toBe(false);
    expect("backgroundTaskId" in output).toBe(false);
  });

  it("returns the same capability failure for an absent port and an absent method", async () => {
    const { port } = stubRunPort({ withoutFillHole: true, snapshot: { holes: [WAITING_HOLE] } });
    const input = { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY };
    const withoutPort = asFailure(
      await fillWorkflowHoleToolEntry.handler(input, executionContext(undefined, "cap")),
    );
    const withoutMethod = asFailure(
      await fillWorkflowHoleToolEntry.handler(input, executionContext(port, "cap")),
    );
    expect(withoutPort.message).toContain("workflow_fill_unavailable");
    expect(withoutMethod).toEqual(withoutPort);
  });
});

// Approval (docs/dynamic-workflow/launch.md "Approval"): the same owner rule as AmendWorkflow — this session's
// run skips the window, another session's run opens one; the window's optionsPolicy is the session-level always-allow.
interface RunOutcome {
  brokerRequests: PermissionBrokerRequest[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

async function runThroughExecutor(options: {
  name: string;
  port: DynamicWorkflowRunPort;
  input?: Record<string, unknown>;
}): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const brokerRequests: PermissionBrokerRequest[] = [];
  const registry = createToolRegistry();
  registry.register(fillWorkflowHoleToolEntry);
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    dynamicWorkflowRunPort: options.port,
    mode: "build",
    permissionBroker: {
      async requestPermission(request) {
        brokerRequests.push(request);
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: CWD,
  });
  const result = await executor.execute(
    {
      id: createToolCallId(options.name),
      input: options.input ?? { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
      name: FILL_WORKFLOW_HOLE_TOOL_NAME,
    },
    { traceContext },
  );
  return {
    brokerRequests,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("FillWorkflowHole — owner rule", () => {
  it("fills a hole of a run this session started without a window", async () => {
    const name = "fill-owned";
    const { port, fills } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), holes: [WAITING_HOLE] },
    });
    const outcome = await runThroughExecutor({ name, port });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    expect(fills).toHaveLength(1);
  });

  it("asks for another session's run, with the hole facts in the input and the session always-allow option", async () => {
    const name = "fill-foreign";
    const { port, fills } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", holes: [WAITING_HOLE] },
    });
    const outcome = await runThroughExecutor({ name, port });
    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    expect(payload.toolName).toBe(FILL_WORKFLOW_HOLE_TOOL_NAME);
    expect(payload.optionsPolicy).toBe("session-always-allow");
    expect(payload.input).toMatchObject({
      run_id: "dwfrun-1",
      hole_id: "hole#1",
      hole: { name: "决定分组", type: "Verdict", owned_by_this_session: false },
    });
    // Allow → the fill proceeds as usual.
    expect(fills).toHaveLength(1);
    expect(outcome.result.success).toBe(true);
  });
});

// Confirmation window: the body names a model outside the run's binding table, so the port necessarily returns 9011
// (bootstrap's unboundFillModelDiagnostics); therefore do not open a window destined to be void — same rule as a
// valid script that does not compile (MR !2837 review CR-01).
describe("FillWorkflowHole — approval gate for models the body names", () => {
  const STORED = [
    'phase("准备");',
    'const v = await hole<string>("裁决", "decide");',
    "return v;",
  ].join("\n");
  const holeId = collectSites(createWorkflowProgram(STORED)).holes[0]!.id;
  const body = (name: string) =>
    `const j = await agent("judge", { model: model(${JSON.stringify(name)}) }).ask<string>("judge it");\nreturn j;`;

  async function gateFor(name: string, modelBindings?: Record<string, string>) {
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: "sess_someone-else",
        holes: [{ ...WAITING_HOLE, siteId: holeId }],
        ...(modelBindings === undefined ? {} : { modelBindings }),
      },
    });
    (port as { getScript?: (runId: string) => Promise<string> }).getScript = async () => STORED;
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: holeId, script: body(name) },
      resolutionContext(port, `fill-gate-${name}`),
    );
    if (!resolved.result) throw new Error("resolveInput refused");
    return fillWorkflowHoleToolEntry.prepareApproval!(resolved.input).gate;
  }

  it("opens the window when every model the body names is in the run's table", async () => {
    expect(await gateFor("GLM-5.3-Flash", { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash" })).toBe("ask");
  });

  it("skips the window when the body names a model outside the table, or the run bound none", async () => {
    expect(await gateFor("GLM-5.3$high", { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash" })).toBe(
      "proceed",
    );
    expect(await gateFor("GLM-5.3-Flash")).toBe("proceed");
  });
});

// Recursive holes (site id `hole#1/hole#1`): the early hole_not_waiting verdict compared siteIds verbatim, the
// `fill_unchanged` key is joined with `\0` (the `/` inside an id does not participate in splitting), and fill files
// are minted by the hole's **name** (names are unique across all holes).
describe("FillWorkflowHole — nested hole ids", () => {
  const NESTED_ID = "hole#1/hole#1";
  const nestedHole = { ...WAITING_HOLE, siteId: NESTED_ID, name: "内层裁决", type: "Inner" };

  it("resolves a nested id, refuses a sibling nested id that is not waiting, and names the fill file by the hole name", async () => {
    const name = "nested";
    const draftsDir = join(CWD, WORKFLOW_DRAFTS_DIR);
    const { port, fills } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        scriptPath: join(draftsDir, "nested.dwf.ts"),
        holes: [{ ...WAITING_HOLE, state: "filled", filledAt: 1 }, nestedHole],
      },
      fill: {
        ok: false,
        reason: "compile_failed",
        message: "no",
        diagnostics: [{ line: 1, column: 1, message: "bad", code: 1, inFill: true }],
      },
    });
    // Outer hole#1 is already filled → hole_not_waiting; inner hole#1/hole#1 is waiting → admitted, with the inner hole's facts block.
    const outer = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY },
        resolutionContext(port, name),
      ),
    );
    expect(outer.message).toContain("already filled");
    const unknown = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: "hole#1/hole#2", script: BODY },
        resolutionContext(port, name),
      ),
    );
    expect(unknown.message).toContain("hole#1/hole#2");
    const resolved = await resolve(
      { run_id: "dwfrun-1", hole_id: NESTED_ID, script: BODY },
      resolutionContext(port, name),
    );
    expect(resolved).toMatchObject({
      result: true,
      input: {
        hole_id: NESTED_ID,
        hole: { name: "内层裁决", type: "Inner", line: 12, owned_by_this_session: true },
      },
    });

    // The fill file is minted by name: `nested.内层裁决.dwf.ts`; the holeId the port receives is the nested id verbatim.
    const output = (await fillWorkflowHoleToolEntry.handler(
      (resolved as { input: unknown }).input,
      executionContext(port, name),
    )) as CreateWorkflowOutput;
    expect(fills[0]).toMatchObject({ holeId: NESTED_ID, body: BODY });
    const fillFile = join(draftsDir, "nested.内层裁决.dwf.ts");
    expect(readFileSync(fillFile, "utf8")).toBe(BODY);
    expect(output.response).toContain(`hole ${NESTED_ID} of run dwfrun-1 is still waiting`);

    // The same bytes handed back via path → fill_unchanged; the nested id in the key was not cut apart by `/`.
    const again = asFailure(
      await resolve(
        { run_id: "dwfrun-1", hole_id: NESTED_ID, path: fillFile },
        resolutionContext(port, name),
      ),
    );
    expect(again.message).toContain("fill_unchanged");
    expect(again.message).toContain(NESTED_ID);
    // Another hole id does not share this record.
    const other = await resolve(
      { run_id: "dwfrun-1", hole_id: "hole#1/hole#3", path: fillFile },
      resolutionContext(port, name),
    );
    expect(other).toMatchObject({ result: false });
    expect((other as ToolHandlerFailure).message).not.toContain("fill_unchanged");
  });
});
