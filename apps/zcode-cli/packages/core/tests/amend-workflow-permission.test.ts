import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunAmendResult,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunRetuneRequest,
  type DynamicWorkflowRunRetuneResult,
  type DynamicWorkflowRunSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { AMEND_WORKFLOW_ERROR_CODE } from "../src/tool/handlers/amend-workflow-resolve.js";
import { workflowRunNotFoundFailure } from "../src/tool/handlers/workflow-run-introspection.js";

// docs/dynamic-workflow/launch.md "The `AmendWorkflow` tool" and "Amending this session's runs":
// resolveInput resolves run_id into a predecessor facts block → the permission service uses it to
// allow this session's runs / ask for others as usual → the handler calls port.amend (the service
// stops the in-flight predecessor, waits for settlement, imports, starts).

function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

/** Scripts from the analyzer corpus (the same corpus and the same reading as create-workflow-tool.test.ts). */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}

const BROKEN_SCRIPT = 'const x: number = "s";';

// A real directory rather than a hardcoded /tmp path: an inline amendment writes drafts into
// `<cwd>/.zcode/workflow-drafts/` (docs/dynamic-workflow/launch.md "Script files"), and cases must
// not see each other's drafts.
const AMEND_CWD = mkdtempSync(join(tmpdir(), "dwf-amend-cwd-"));
afterAll(() => {
  rmSync(AMEND_CWD, { force: true, recursive: true });
});

/** This session's id is derived from the case name (the same derivation in run()), so ownership is controllable here. */
function sessionOf(name: string): string {
  return createSessionId(name) as unknown as string;
}

interface StubPortOptions {
  /** getTask's answer: absent means "the run does not exist". */
  snapshot?: Partial<DynamicWorkflowRunSnapshot>;
  /** amend's answer; defaults to successfully minting `dwfrun-amended`. */
  amend?: DynamicWorkflowRunAmendResult;
  /** Default concurrency D; absent means the port has no `defaultConcurrency` (the old-host shape). */
  defaultConcurrency?: number;
  /**
   * The predecessor's stored script, i.e. `getScript`'s answer (docs/dynamic-workflow/launch.md
   * "Keeping the predecessor's script"). Absent means the port has **no** `getScript` (the
   * old-host shape); `null` means the method exists but the record has no script (an old run from
   * before scripts were persisted).
   */
  storedScript?: string | null;
  /**
   * `retuneConcurrency`'s reply (docs/dynamic-workflow/launch.md "Changing only the parallelism of
   * a live run"). Absent means the port has **no** such method (the old-host shape) — in that era
   * a concurrency-only call still went down the amendment path.
   */
  retune?:
    | DynamicWorkflowRunRetuneResult
    | ((request: DynamicWorkflowRunRetuneRequest) => DynamicWorkflowRunRetuneResult);
}

function stubRunPort(options: StubPortOptions = {}): {
  port: DynamicWorkflowRunPort;
  amends: DynamicWorkflowRunAmendRequest[];
  getTaskCalls: string[];
  getScriptCalls: string[];
  retunes: DynamicWorkflowRunRetuneRequest[];
} {
  const amends: DynamicWorkflowRunAmendRequest[] = [];
  const getTaskCalls: string[] = [];
  const getScriptCalls: string[] = [];
  const retunes: DynamicWorkflowRunRetuneRequest[] = [];
  const unreachable = (name: string) => () => {
    throw new Error(`stubRunPort.${name} 不应被 AmendWorkflow 触及`);
  };
  return {
    port: {
      async getTask(taskId: string) {
        getTaskCalls.push(taskId);
        if (options.snapshot === undefined) return undefined;
        // Only base-class fields; `runStatus` is decided by the case — absent means "still running"
        // (resolveInput reads it as running).
        return {
          runId: taskId,
          taskId,
          startedAt: new Date(0),
          status: "running",
          ...options.snapshot,
        } as DynamicWorkflowRunSnapshot;
      },
      async amend(request) {
        amends.push(request);
        return options.amend ?? { ok: true, runId: "dwfrun-amended" };
      },
      ...(options.defaultConcurrency === undefined
        ? {}
        : { defaultConcurrency: () => options.defaultConcurrency as number }),
      ...(options.storedScript === undefined
        ? {}
        : {
            async getScript(runId: string) {
              getScriptCalls.push(runId);
              return options.storedScript ?? undefined;
            },
          }),
      ...(options.retune === undefined
        ? {}
        : {
            async retuneConcurrency(request: DynamicWorkflowRunRetuneRequest) {
              retunes.push(request);
              return typeof options.retune === "function"
                ? options.retune(request)
                : (options.retune as DynamicWorkflowRunRetuneResult);
            },
          }),
      submit: unreachable("submit"),
      waitForTask: unreachable("waitForTask"),
      cancel: unreachable("cancel"),
      listEvents: unreachable("listEvents"),
    } as unknown as DynamicWorkflowRunPort,
    amends,
    getTaskCalls,
    getScriptCalls,
    retunes,
  };
}

interface RunOptions {
  broker?: PermissionBrokerPort;
  input?: Record<string, unknown>;
  /** The host's model catalog; absent means "this machine cannot choose a subagent model". */
  modelCatalogPort?: ModelCatalogPort;
  mode?: CollaborationMode;
  name: string;
  port?: DynamicWorkflowRunPort;
  runId?: string;
  script?: string;
}

interface RunOutcome {
  brokerRequests: PermissionBrokerRequest[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const brokerRequests: PermissionBrokerRequest[] = [];
  const permissionBroker: PermissionBrokerPort = {
    async requestPermission(request, requestOptions) {
      brokerRequests.push(request);
      return (
        options.broker?.requestPermission(request, requestOptions) ?? { decision: "allow" as const }
      );
    },
  };
  const registry = createToolRegistry();
  registry.register(amendWorkflowToolEntry);
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.port ? { dynamicWorkflowRunPort: options.port } : {}),
    ...(options.modelCatalogPort ? { modelCatalogPort: options.modelCatalogPort } : {}),
    mode: options.mode ?? "build",
    permissionBroker,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: AMEND_CWD,
  });
  const result = await executor.execute(
    {
      id: createToolCallId(options.name),
      input: options.input ?? {
        run_id: options.runId ?? "dwfrun-prev",
        script: options.script ?? cleanScript(options.name),
      },
      name: "AmendWorkflow",
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

describe("AmendWorkflow — owner rule", () => {
  it("amends a settled run this session started without a window, naming both runs", async () => {
    const name = "amend-owned-settled";
    const { port, amends, getTaskCalls } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), runStatus: "errored", status: "failed" },
    });
    const outcome = await run({ name, port });

    // The first getTask is resolveInput resolving the predecessor; the later ones are the
    // background tracker polling the new run (same as CreateWorkflow).
    expect(getTaskCalls[0]).toBe("dwfrun-prev");
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({
      cwd: AMEND_CWD,
      predecessorRunId: "dwfrun-prev",
      parentSessionId: sessionOf(name),
    });
    expect("name" in amends[0]!).toBe(false);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.backgroundTaskId).toBe("dwfrun-amended");
    expect(output.response).toContain("dwfrun-prev had already settled");
    expect(output.response).toContain("run dwfrun-amended");
    expect(output.response).toContain("Do not wait for it");
  });

  it("amends a RUNNING run this session started without a window and reports the supersede", async () => {
    const name = "amend-owned-running";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "running" },
      amend: { ok: true, runId: "dwfrun-next", supersededRunId: "dwfrun-prev" },
    });
    const outcome = await run({ name, port, mode: "plan" });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.backgroundTaskId).toBe("dwfrun-next");
    expect(output.response).toContain("dwfrun-prev was still running");
    expect(output.response).toContain("stopped and superseded");
    expect(output.response).toContain("will not send a notification of its own");
  });

  // The track draws the **new script's** sites: an amendment inherits the predecessor's anchors,
  // yet both tables must be taken from the new script's graph together.
  it("passes the new script's phase table and its alongside table through", async () => {
    const name = "amend-alongside";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
    });
    await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", script: fixture("strand-fanout-two-phases-join.ts") },
    });
    expect(amends).toHaveLength(1);
    expect(amends[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(amends[0]!.phaseAlongside).toEqual([[], [0], []]);
  });

  it("passes the optional display name through", async () => {
    const name = "amend-owned-named";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
    });
    await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", script: cleanScript(name), name: "second pass" },
    });
    expect(amends[0]?.name).toBe("second pass");
  });

  it("asks for another session's run, with the create_workflow graph and the predecessor facts in the input", async () => {
    const name = "amend-foreign";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
    });
    const outcome = await run({ name, port });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    expect(payload.toolName).toBe("AmendWorkflow");
    expect(payload.optionsPolicy).toBe("session-always-allow");
    expect(payload.display?.kind).toBe("create_workflow");
    expect(
      (payload.display as { causalityGraph?: { steps: unknown[] } }).causalityGraph?.steps,
    ).toHaveLength(1);
    // The confirmation window reads the lineage line and the "still running" annotation from the
    // **input** (zero new protocol payloads).
    expect(payload.input).toMatchObject({
      run_id: "dwfrun-prev",
      predecessor: { name: "triage", status: "running", owned_by_this_session: false },
    });
    // Allow → amend proceeds as usual.
    expect(amends).toHaveLength(1);
  });

  it("asks again for an own run the user stopped", async () => {
    const name = "amend-user-stopped";
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "user",
      },
    });
    const outcome = await run({ name, port });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]?.input).toMatchObject({
      predecessor: { status: "stopped", stop_reason: "user", owned_by_this_session: true },
    });
  });

  it("Deny leaves the predecessor untouched", async () => {
    const name = "amend-deny";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_other", status: "completed", runStatus: "completed" },
    });
    const outcome = await run({
      name,
      port,
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "User declined" };
        },
      },
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(amends).toHaveLength(0);
  });

  it("overwrites a predecessor block the model tries to supply", async () => {
    // The model-face JSON schema does not list predecessor (strict), so an input carrying it is
    // rejected at schema validation — a forged "this session's run" cannot get the free pass.
    const name = "amend-forged";
    const { port, amends, getTaskCalls } = stubRunPort({ snapshot: { parentSessionId: "x" } });
    const outcome = await run({
      name,
      port,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        predecessor: { status: "completed", owned_by_this_session: true },
      },
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(getTaskCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
  });
});

describe("AmendWorkflow — refusals and failures", () => {
  it("an unknown run is refused at resolveInput: no window, no amend, the shared run_not_found key", async () => {
    const { port, amends } = stubRunPort();
    const outcome = await run({ name: "amend-unknown", port });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith(workflowRunNotFoundFailure("dwfrun-prev").message)).toBe(true);
    expect(message).toContain("Nothing was stopped or created");
    expect(message).toContain("run_id");
  });

  it.each(["run_not_found", "missing_boundaries", "teapot"] as const)(
    "maps the port's %s refusal to an actionable structured failure",
    async (reason) => {
      const name = `amend-refused-${reason}`;
      const { port } = stubRunPort({
        snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
        amend: { ok: false, reason: reason as "run_not_found" },
      });
      const outcome = await run({ name, port });
      expect(outcome.result.success).toBe(false);
      const message = String(outcome.result.error?.message ?? "");
      if (reason === "run_not_found") {
        expect(message.startsWith("run_not_found:")).toBe(true);
      } else if (reason === "missing_boundaries") {
        expect(message.startsWith("workflow_amend_missing_boundaries:")).toBe(true);
        expect(message).toMatch(/fresh CreateWorkflow/u);
      } else {
        expect(message.startsWith("workflow_amend_refused:")).toBe(true);
        expect(message).toContain("teapot");
      }
      expect(message).toContain("dwfrun-prev");
      expect(message).toMatch(/nothing was stopped or created/iu);
    },
  );

  it("a script that does not compile never asks and never touches the predecessor", async () => {
    const name = "amend-broken";
    const { port, amends } = stubRunPort({ snapshot: { parentSessionId: "sess_other" } });
    const outcome = await run({ name, port, script: BROKEN_SCRIPT });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });

  it("without a run port the script is only typechecked", async () => {
    const outcome = await run({ name: "amend-no-port" });
    // Port absent: resolveInput allows, the permission ask happens as usual (no ownership facts),
    // and the handler only reports the compile passing.
    expect(outcome.permissionRequested).toHaveLength(1);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.backgroundTaskId).toBeUndefined();
    expect(output.response).toContain("NOT executed");
  });
});

// The concurrency bound's three states (docs/dynamic-workflow/concurrency.md "Two bounds on a
// run"): omitted = inherit the predecessor, `null` = lift it, a number = set it. The three states
// live only up to resolveInput — the handler and the confirmation window afterwards face only "a
// number or nothing", and the handler itself re-parses the normalized input with .strict(), so a
// shape violation must explode in these cases.
describe("AmendWorkflow — max_concurrency", () => {
  /** The number that reaches the port after normalization; an absent key means undefined. */
  async function amendWith(
    name: string,
    options: { defaultConcurrency?: number; inherited?: number; requested?: number | null },
  ): Promise<{ amends: DynamicWorkflowRunAmendRequest[]; outcome: RunOutcome }> {
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "completed",
        runStatus: "completed",
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      ...(options.defaultConcurrency === undefined
        ? {}
        : { defaultConcurrency: options.defaultConcurrency }),
    });
    const outcome = await run({
      name,
      port,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        ...(options.requested === undefined ? {} : { max_concurrency: options.requested }),
      },
    });
    return { amends, outcome };
  }

  it("a number above the default goes through unclamped and is named in the result", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-raised", {
      defaultConcurrency: 8,
      requested: 32,
    });
    expect(amends[0]?.maxConcurrency).toBe(32);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 32 subagents run at once.",
    );
  });

  it("a number equal to the default is named as the default", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-at-default", {
      defaultConcurrency: 8,
      requested: 8,
    });
    expect(amends[0]?.maxConcurrency).toBe(8);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 8 subagents run at once (the default).",
    );
  });

  it("a number under the default goes through unchanged", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-set", {
      defaultConcurrency: 8,
      requested: 2,
    });
    expect(amends[0]?.maxConcurrency).toBe(2);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("At most 2 subagents run at once.");
    expect(response).not.toContain("(the default)");
  });

  it("null removes the predecessor's limit: the key is gone, not zeroed", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-null", {
      defaultConcurrency: 8,
      inherited: 2,
      requested: null,
    });
    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain("At most");
  });

  it("omitting the field inherits the predecessor's limit", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-inherit", {
      defaultConcurrency: 8,
      inherited: 2,
    });
    expect(amends[0]?.maxConcurrency).toBe(2);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 2 subagents run at once.",
    );
  });

  it("omitting the field inherits a raised predecessor's limit as is", async () => {
    // The snapshot carries maxConcurrency only when it differs from the default: a raised
    // predecessor passes its number down as is, no longer clamped.
    const { amends } = await amendWith("amend-maxconc-inherit-raised", {
      defaultConcurrency: 8,
      inherited: 40,
    });
    expect(amends[0]?.maxConcurrency).toBe(40);
  });

  it("omitting it stays absent when the predecessor ran at the default", async () => {
    // The snapshot carries maxConcurrency only when it differs from the default, so "the
    // predecessor never set one" is exactly the field being absent here.
    const { amends } = await amendWith("amend-maxconc-none", { defaultConcurrency: 8 });
    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
  });

  it("shows the inherited limit in the confirmation window of another session's run", async () => {
    // The confirmation window reads the normalized input: the inherited bound must be there,
    // otherwise the user is approving a different run.
    const { port } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({
      name: "amend-maxconc-window",
      port,
      input: { run_id: "dwfrun-prev", script: cleanScript("amend-maxconc-window") },
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({ max_concurrency: 2 });
  });

  it("strips null and passes a number through when the session has no run port", async () => {
    // Port absent: there is no predecessor and no default concurrency, the three states collapse to
    // "a number or nothing", and the normalized input must still survive the handler's .strict()
    // re-parse.
    const removed = await run({
      name: "amend-maxconc-no-port-null",
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-maxconc-no-port-null"),
        max_concurrency: null,
      },
    });
    expect(removed.result.success).toBe(true);
    expect(removed.permissionRequested[0]!.input).not.toHaveProperty("max_concurrency");

    const kept = await run({
      name: "amend-maxconc-no-port-number",
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-maxconc-no-port-number"),
        max_concurrency: 4,
      },
    });
    expect(kept.permissionRequested[0]!.input).toMatchObject({ max_concurrency: 4 });
  });
});

// The subagent model's three states (docs/dynamic-workflow/launch.md): omitted = inherit the
// predecessor, `null` = back to the session model, a string = set it. Isomorphic to the concurrency
// bound case by case; the only difference is that **the inherited one is re-resolved too** — the
// predecessor may have started days ago, and the model it chose may since have been deleted or
// disabled.
describe("AmendWorkflow — subagent_model", () => {
  function entry(
    providerId: string,
    modelId: string,
    extra: Partial<ModelCatalogEntry> = {},
  ): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
  }

  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      entry("bigmodel", "GLM-4.6", { current: true }),
      entry("openai", "gpt-5"),
    ],
  };

  /** Only one model left in the catalog: the one the predecessor chose is gone. */
  const SHRUNK_CATALOG: ModelCatalogPort = {
    listModels: () => [entry("openai", "gpt-5", { current: true })],
  };

  async function amendWith(
    name: string,
    options: {
      catalog?: ModelCatalogPort;
      inherited?: string;
      requested?: string | null;
    },
  ): Promise<{ amends: DynamicWorkflowRunAmendRequest[]; outcome: RunOutcome }> {
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "completed",
        runStatus: "completed",
        ...(options.inherited === undefined ? {} : { subagentModel: options.inherited }),
      },
    });
    const outcome = await run({
      name,
      port,
      ...(options.catalog === undefined ? {} : { modelCatalogPort: options.catalog }),
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        ...(options.requested === undefined ? {} : { subagent_model: options.requested }),
      },
    });
    return { amends, outcome };
  }

  it("a model id is resolved to its canonical form and named in the result", async () => {
    const { amends, outcome } = await amendWith("amend-model-set", {
      catalog: CATALOG,
      requested: "gpt-5",
    });
    expect(amends[0]?.subagentModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "Subagents run on openai/gpt-5 (the main agent stays on the session model).",
    );
  });

  it("null puts the subagents back on the session model: the key is gone, not blanked", async () => {
    const { amends, outcome } = await amendWith("amend-model-null", {
      catalog: CATALOG,
      inherited: "bigmodel/GLM-4.6",
      requested: null,
    });
    expect(amends).toHaveLength(1);
    expect("subagentModel" in amends[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain(
      "Subagents run on",
    );
  });

  it("omitting the field inherits the predecessor's model", async () => {
    const { amends, outcome } = await amendWith("amend-model-inherit", {
      catalog: CATALOG,
      inherited: "bigmodel/GLM-4.6",
    });
    expect(amends[0]?.subagentModel).toEqual({ providerId: "bigmodel", modelId: "GLM-4.6" });
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "Subagents run on bigmodel/GLM-4.6",
    );
  });

  it("omitting it stays absent when the predecessor ran on the session model", async () => {
    const { amends } = await amendWith("amend-model-none", { catalog: CATALOG });
    expect(amends).toHaveLength(1);
    expect("subagentModel" in amends[0]!).toBe(false);
  });

  /**
   * The inherited one is re-resolved too: without re-resolving, the failure would wait until the
   * subagent's first utterance, looking like a runtime failure rather than a choice that could
   * have been fixed on the spot.
   */
  it("fails now, not at the first ask, when the inherited model has vanished from the catalog", async () => {
    const { amends, outcome } = await amendWith("amend-model-vanished", {
      catalog: SHRUNK_CATALOG,
      inherited: "bigmodel/GLM-4.6",
    });
    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    // The wording must make clear it was **inherited**: this call never mentioned a model name.
    expect(message).toContain("inherited the predecessor run's subagent model");
    expect(message).toContain("bigmodel/GLM-4.6");
    expect(message).toContain("subagent_model: null");
    expect(message).toContain("Nothing was stopped or created.");
  });

  it("an unresolvable id stops the call before anything is stopped or created", async () => {
    const { amends, outcome } = await amendWith("amend-model-miss", {
      catalog: CATALOG,
      requested: "gemini-3",
    });
    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(String(outcome.result.error?.message ?? "")).toContain("No configured model matches");
  });

  it("shows the inherited model in the confirmation window of another session's run", async () => {
    // The confirmation window reads the normalized input: the inherited model must be there,
    // otherwise the user is approving a different run.
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: "sess_someone-else",
        status: "running",
        subagentModel: "bigmodel/GLM-4.6",
      },
    });
    const outcome = await run({
      name: "amend-model-window",
      port,
      modelCatalogPort: CATALOG,
      input: { run_id: "dwfrun-prev", script: cleanScript("amend-model-window") },
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      subagent_model: "bigmodel/GLM-4.6",
    });
  });

  it("refuses a model id on a host with no catalog, and still strips null", async () => {
    const refused = await amendWith("amend-model-no-catalog", { requested: "gpt-5" });
    expect(refused.outcome.result.success).toBe(false);
    expect(String(refused.outcome.result.error?.message ?? "")).toContain(
      "This host cannot choose a subagent model",
    );

    const removed = await amendWith("amend-model-no-catalog-null", { requested: null });
    expect(removed.outcome.result.success).toBe(true);
    expect("subagentModel" in removed.amends[0]!).toBe(false);
  });

  it("strips the field and passes a resolved id through when the session has no run port", async () => {
    // Port absent: there is no predecessor to inherit from, so `null` and omission both collapse to
    // absence, while a given string still gets resolved once — the normalized input must also
    // survive the handler's .strict() re-parse.
    const resolved = await run({
      name: "amend-model-no-port",
      modelCatalogPort: CATALOG,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-model-no-port"),
        subagent_model: "gpt-5",
      },
    });
    expect(resolved.result.success).toBe(true);
    expect(resolved.permissionRequested[0]!.input).toMatchObject({
      subagent_model: "openai/gpt-5",
    });

    const removed = await run({
      name: "amend-model-no-port-null",
      modelCatalogPort: CATALOG,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-model-no-port-null"),
        subagent_model: null,
      },
    });
    expect(removed.result.success).toBe(true);
    expect(removed.permissionRequested[0]!.input).not.toHaveProperty("subagent_model");
  });
});

// Omitting `script` = keep the predecessor's script (docs/dynamic-workflow/launch.md "Keeping the
// predecessor's script"): the same rule and the same lifecycle as the two settings — resolveInput
// reads the predecessor's stored script, backfills it into the input, and stamps
// `predecessor.script_inherited`; from then on the hook, the confirmation window, prepareApproval
// and the handler all face "one script", and the port always receives exactly one script.
describe("AmendWorkflow — omitted script", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  it("keeps the predecessor's script byte for byte and changes only the settings", async () => {
    const name = "amend-keep-script";
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(true);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(amends).toHaveLength(1);
    expect(amends[0]!.scriptText).toBe(STORED);
    expect(amends[0]!.maxConcurrency).toBe(2);
    // The phase tables are taken from the backfilled script: the sidebar track still draws the
    // script that is about to run.
    expect(amends[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(amends[0]!.phaseAlongside).toEqual([[], [0], []]);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.response).toContain(
      "The script of run dwfrun-prev started unchanged in the background as run dwfrun-amended.",
    );
    expect(output.response).not.toContain("revised script");
    expect(output.response).toContain("At most 2 subagents run at once.");
  });

  it("with nothing but run_id, re-runs the script under the predecessor's settings", async () => {
    const name = "amend-keep-everything";
    const catalog: ModelCatalogPort = {
      listModels: () => [
        { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: true },
      ],
    };
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "failed",
        runStatus: "errored",
        maxConcurrency: 3,
        subagentModel: "openai/gpt-5",
      },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name,
      port,
      modelCatalogPort: catalog,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.result.success).toBe(true);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({
      scriptText: STORED,
      maxConcurrency: 3,
      subagentModel: { providerId: "openai", modelId: "gpt-5" },
    });
  });

  it("asks for another session's run with the predecessor's script, its graph and the inherited flag", async () => {
    const stored = cleanScript("amend-keep-foreign");
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
      storedScript: stored,
    });
    const outcome = await run({
      name: "amend-keep-foreign",
      port,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    // The confirmation window and the hook read the normalized input: the script is exactly the one
    // that will run, and the flag lets the window say "the script is unchanged".
    expect(payload.input).toMatchObject({
      run_id: "dwfrun-prev",
      script: stored,
      predecessor: {
        name: "triage",
        status: "running",
        owned_by_this_session: false,
        script_inherited: true,
      },
    });
    expect(payload.display?.kind).toBe("create_workflow");
    expect(
      (payload.display as { causalityGraph?: { steps: unknown[] } }).causalityGraph?.steps,
    ).toHaveLength(1);
    expect(amends).toHaveLength(1);
    expect(amends[0]!.scriptText).toBe(stored);
  });

  it("a passed script never reads the stored one and carries no inherited flag", async () => {
    const script = cleanScript("amend-pass-script");
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "completed" },
      storedScript: "return 'stale';",
    });
    const outcome = await run({ name: "amend-pass-script", port, script });

    expect(getScriptCalls).toHaveLength(0);
    const predecessor = (outcome.permissionRequested[0]!.input as Record<string, unknown>)
      .predecessor as Record<string, unknown>;
    expect(predecessor).not.toHaveProperty("script_inherited");
    expect(amends[0]!.scriptText).toBe(script);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "The revised script started in the background as run dwfrun-amended.",
    );
  });

  it("an unknown run is refused as run_not_found before the script is read", async () => {
    const { port, amends, getScriptCalls } = stubRunPort({ storedScript: STORED });
    const outcome = await run({
      name: "amend-keep-unknown",
      port,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.result.success).toBe(false);
    expect(String(outcome.result.error?.message ?? "").startsWith("run_not_found:")).toBe(true);
    expect(getScriptCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
  });

  it.each([
    [
      "a predecessor whose record has no script",
      "no-record",
      { storedScript: null },
      "has no stored script",
    ],
    ["a host whose port cannot read scripts", "no-method", {}, "cannot read"],
  ] as const)(
    "%s is refused before any window, pointing at the whole script",
    async (_label, key, options, detail) => {
      const name = `amend-keep-unavailable-${key}`;
      const { port, amends } = stubRunPort({
        snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
        ...options,
      });
      const outcome = await run({
        name,
        port,
        input: { run_id: "dwfrun-prev", max_concurrency: 2 },
      });

      expect(outcome.result.success).toBe(false);
      expect(outcome.permissionRequested).toHaveLength(0);
      expect(amends).toHaveLength(0);
      const message = String(outcome.result.error?.message ?? "");
      expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
      expect(message).toContain("dwfrun-prev");
      expect(message).toContain(detail);
      expect(message).toContain("pass the whole script");
      expect(message).toContain("Nothing was stopped or created.");
    },
  );

  it("a session without a run port is refused the same way: there is nothing to typecheck", async () => {
    const outcome = await run({ name: "amend-keep-no-port", input: { run_id: "dwfrun-prev" } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
    expect(message).toContain("pass the whole script");
  });

  /**
   * An inherited script that no longer compiles (the facade changed after the predecessor): the
   * model wrote none of these lines in this call, and without saying so the diagnostics would be
   * read as "you passed the wrong argument" — the same reasoning as "the inherited model is no
   * longer available".
   */
  it("an inherited script that no longer compiles says it was inherited, and touches nothing", async () => {
    const name = "amend-keep-broken";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "running" },
      storedScript: BROKEN_SCRIPT,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    const [lead] = output.response.split("\n");
    expect(lead).toContain("run dwfrun-prev's script");
    expect(lead).toContain("inherited because you omitted both `script` and `path`");
    expect(output.response).toMatch(/L\d+:C\d+ /u);
    // An inherited script lands as a draft like any script not coming from a file
    // (docs/dynamic-workflow/launch.md "Script files"), so the next step is to edit that file, not
    // to paste the whole script inline again.
    expect(output.response).toContain("Edit that file in place and resubmit with `path:");
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });
});

// Concurrency-only while the run is alive = retune in place, not an amendment
// (docs/dynamic-workflow/launch.md "Changing only the parallelism of a live run"): the same run id,
// no successor minted, no supersede, no script read, no compile, not a single window. The routing
// is decided in resolveInput, and the handler calls `port.retuneConcurrency`.
describe("AmendWorkflow — 只改并发即就地生效", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  /** A running predecessor owned by this session whose port has retuneConcurrency. */
  function liveRetunablePort(
    name: string,
    options: {
      defaultConcurrency?: number;
      inherited?: number;
      owner?: string;
      retune?: StubPortOptions["retune"];
      runStatus?: DynamicWorkflowRunSnapshot["runStatus"];
      storedScript?: string | null;
    } = {},
  ): ReturnType<typeof stubRunPort> {
    return stubRunPort({
      snapshot: {
        parentSessionId: options.owner ?? sessionOf(name),
        status: "running",
        ...(options.runStatus === undefined ? {} : { runStatus: options.runStatus }),
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      defaultConcurrency: options.defaultConcurrency ?? 8,
      retune: options.retune ?? { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 },
      ...(options.storedScript === undefined ? {} : { storedScript: options.storedScript }),
    });
  }

  it("retunes in place: one run named, no successor, no compile, no script read, no window", async () => {
    const name = "retune-ok";
    const { port, amends, retunes, getScriptCalls } = liveRetunablePort(name, {
      retune: { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 },
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(true);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    // This path reads no script, compiles nothing, and starts no successor.
    expect(getScriptCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
    expect(retunes).toEqual([{ runId: "dwfrun-prev", maxConcurrency: 2 }]);

    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.status).toBeUndefined();
    expect(output.backgroundTaskId).toBeUndefined();
    expect(output.causalityGraph).toBeUndefined();
    // "Applied in place" is an explicit block; consumers do not guess from the shape, and the tool
    // card uses it to avoid drawing "compiled".
    expect(output.retuned).toEqual({
      runId: "dwfrun-prev",
      maxConcurrency: 2,
      previous: 8,
      defaultConcurrency: 8,
    });
    // No display payload: this path compiled not one line of script, while `create_workflow`'s `ok`
    // reads as "compiled" on the card.
    expect(outcome.result.display).toBeUndefined();
    expect(output.response).toContain("Applied to the running run dwfrun-prev");
    expect(output.response).toContain("at most 2 subagents run at once");
    expect(output.response).toContain("no new run was started");
    // Only one run is named: the model uses that to tell which path this call took.
    expect(output.response).not.toContain("superseded");
  });

  it("null travels to the port as null and the applied default is named as the default", async () => {
    const name = "retune-null";
    const { port, retunes } = liveRetunablePort(name, {
      inherited: 2,
      retune: { ok: true, maxConcurrency: 8, previous: 2, defaultConcurrency: 8 },
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: null },
    });

    // The port receives the three-state `null` itself: only the port knows the default concurrency
    // number, and the tool does not guess it a second time.
    expect(retunes).toEqual([{ runId: "dwfrun-prev", maxConcurrency: null }]);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("Applied to the running run dwfrun-prev");
    expect(response).toContain("at most 8 subagents run at once (the default)");
  });

  it("a number above the default reaches the port as is and is applied as is", async () => {
    const name = "retune-raised";
    const { port, retunes } = liveRetunablePort(name, {
      defaultConcurrency: 16,
      inherited: 2,
      retune: { ok: true, maxConcurrency: 32, previous: 2, defaultConcurrency: 16 },
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 32 },
    });

    // The default concurrency is not a ceiling: neither the tool nor the port clamps, and what the
    // model reads is exactly the 32 it asked for.
    expect(retunes[0]?.maxConcurrency).toBe(32);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("at most 32 subagents run at once");
    expect(response).not.toContain("(the default)");
  });

  it("the same bound is refused `unchanged` before any hook, naming the bound in force", async () => {
    const name = "retune-unchanged";
    const { port, retunes, amends, getScriptCalls } = liveRetunablePort(name, { inherited: 2 });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    // Earlier than hook and confirmation window: the port was never touched.
    expect(retunes).toHaveLength(0);
    expect(amends).toHaveLength(0);
    expect(getScriptCalls).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
    expect(message).toContain("2");
    expect(message).toMatch(/nothing was stopped/iu);
  });

  it("null against a run already at the default is `unchanged` too", async () => {
    const name = "retune-unchanged-default";
    const { port, retunes } = liveRetunablePort(name);
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: null },
    });

    expect(outcome.result.success).toBe(false);
    expect(retunes).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain(
      "already runs at the default parallelism (at most 8 subagents at once)",
    );
  });

  it("the port's own `unchanged` (the value moved under us) is the same refusal", async () => {
    const name = "retune-unchanged-race";
    const { port, amends } = liveRetunablePort(name, {
      inherited: 4,
      retune: { ok: false, reason: "unchanged", current: 2 },
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain("2");
  });

  it.each([
    ["a revised script", { script: cleanScript("retune-with-script") }],
    ["a script file", { path: "nope.ts" }],
    ["a subagent model", { subagent_model: null }],
    ["a name", { name: "second pass" }],
  ] as const)("%s sends the call down the amendment path", async (_label, extra) => {
    const name = `retune-not-only-${Object.keys(extra)[0]}`;
    const { port, retunes, amends } = liveRetunablePort(name, { storedScript: STORED });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2, ...extra },
    });

    expect(retunes).toHaveLength(0);
    if ("path" in extra) {
      // An unreadable file is the amendment's own failure — proof this call really went down the
      // amendment path.
      expect(outcome.result.success).toBe(false);
      expect(String(outcome.result.error?.message ?? "")).toContain(
        "workflow_script_file_unreadable:",
      );
      return;
    }
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  it("a run that already settled takes the amendment, unchanged", async () => {
    const name = "retune-settled";
    const { port, retunes, amends, getScriptCalls } = liveRetunablePort(name, {
      runStatus: "errored",
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(retunes).toHaveLength(0);
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(amends).toHaveLength(1);
    expect(amends[0]?.maxConcurrency).toBe(2);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  it("a port with no retuneConcurrency keeps today's amendment, window and all", async () => {
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-old-host",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  // "No window" holds for any ownership: the window exists to put a script in front of a person,
  // and this path runs no script at all.
  /**
   * The refusal must go out through the **same exit** as this tool's existing ones
   * (run_not_found / missing_boundaries / script_unchanged): `success: false` + a coded `error`,
   * no output. This path carries no display payload, so the read side (the tool card) can only tell
   * "the call succeeded" from "it was refused" by whether it is an error — the two outcomes' inputs
   * look identical.
   */
  /**
   * The reply text is the **only** fact that survives v4 (this path has no display payload; the
   * protocol's toolOutput carries only text), and the tool card draws the whole line from it. So
   * both bounds are pinned verbatim: changing a word is changing the UI.
   */
  it.each([
    [
      "a bound below the default",
      { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 2 subagents run at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "a bound of one",
      { ok: true, maxConcurrency: 1, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 1 subagent runs at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "the default",
      { ok: true, maxConcurrency: 8, previous: 2, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 8 subagents run at once (the default). Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "a bound above the default",
      { ok: true, maxConcurrency: 40, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 40 subagents run at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
  ] as const)("reads back verbatim for %s", async (label, retune, expected) => {
    const name = `retune-text-${label.replace(/\s+/gu, "-")}`;
    const { port } = liveRetunablePort(name, { inherited: 4, retune });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect((outcome.result.output as CreateWorkflowOutput).response).toBe(expected);
  });

  it("a refusal comes back as a tool error with no output, like every other one", async () => {
    const name = "retune-refusal-shape";
    const { port } = liveRetunablePort(name, { inherited: 2 });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    // The code is the stable discriminator (house rule: never branch on error text), taken from the
    // code table rather than scattered literals.
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED));
    expect(
      String(outcome.result.error?.message ?? "").startsWith("workflow_retune_unchanged:"),
    ).toBe(true);
  });

  it("another session's live run is retuned with no window either", async () => {
    const { port, retunes } = liveRetunablePort("retune-foreign-live", {
      owner: "sess_someone-else",
    });
    const outcome = await run({
      name: "retune-foreign-live",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(retunes).toHaveLength(1);
    expect(outcome.result.success).toBe(true);
  });
});

// Settlement race (docs/dynamic-workflow/launch.md "When the port says `not_live`"): the same input
// describes an amendment at this instant, and whether it can proceed depends on whether that
// amendment would have opened a window in the first place.
describe("AmendWorkflow — 就地调并发遇上 not_live", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  /**
   * What resolveInput sees is still live (the port answers not_live afterwards); by the time the
   * handler reads the snapshot again it is the terminal state `settled` describes. The two getTask
   * calls answering different facts are exactly the race this path covers.
   */
  function racingPort(options: {
    owner: string;
    inherited?: number;
    settled?: Partial<DynamicWorkflowRunSnapshot>;
    storedScript?: string | null;
  }): ReturnType<typeof stubRunPort> {
    const base = stubRunPort({
      snapshot: {
        parentSessionId: options.owner,
        status: "running",
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      defaultConcurrency: 8,
      retune: { ok: false, reason: "not_live" },
      ...(options.storedScript === undefined ? {} : { storedScript: options.storedScript }),
    });
    let reads = 0;
    const port = base.port as unknown as Record<string, unknown>;
    const first = port.getTask as (runId: string) => Promise<DynamicWorkflowRunSnapshot>;
    port.getTask = async (runId: string) => {
      const snapshot = await first(runId);
      reads += 1;
      // The first read (resolveInput) still reads as running; the second (the handler's
      // fall-through) reads the terminal state.
      return reads === 1 ? snapshot : ({ ...snapshot, ...options.settled } as typeof snapshot);
    };
    return base;
  }

  it("this session's own run falls through to a real amendment, reading the script at that point", async () => {
    const name = "retune-race-own";
    const { port, retunes, amends, getScriptCalls } = racingPort({
      owner: sessionOf(name),
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(retunes).toHaveLength(1);
    // The script is read **at this point**: the retune path never read it once.
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({ scriptText: STORED, maxConcurrency: 2 });
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.response).toContain("started unchanged in the background as run dwfrun-amended");
  });

  it("null on the fall-through removes the limit: the port gets no maxConcurrency key", async () => {
    const name = "retune-race-own-null";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      // The predecessor was pinned at 2, so `null` (back to default) really is a change, not
      // `unchanged`.
      inherited: 2,
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: null } });

    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
  });

  it("a missing script on the fall-through is reported as the amendment's own refusal", async () => {
    const name = "retune-race-own-no-script";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "completed", runStatus: "completed" },
      storedScript: null,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
    expect(message).toContain("pass the whole script");
  });

  it("a script that no longer compiles on the fall-through comes back as diagnostics", async () => {
    const name = "retune-race-own-broken";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "failed", runStatus: "errored" },
      storedScript: BROKEN_SCRIPT,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });

  it("another session's settled run is refused `run_settled`, not amended", async () => {
    const { port, amends } = racingPort({
      owner: "sess_someone-else",
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-race-foreign-settled",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    // The same exit as the existing refusals: error + null output (the read side has no display to
    // look at and can only tell the outcomes apart by this).
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.RUN_SETTLED));
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_run_settled:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
    expect(message).toMatch(/call .*again/iu);
  });

  it("another session's run this agent never held live is refused `not_retunable`", async () => {
    const { port, amends } = racingPort({
      owner: "sess_someone-else",
      settled: { runStatus: "pending" },
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-race-foreign-pending",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.NOT_RETUNABLE));
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_run_not_retunable:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
  });

  // A run the user stopped by hand would have opened a window on the amendment path (the owner rule
  // excludes it), so the fall-through must not skip that on its behalf.
  it("an own run the user stopped is refused instead of silently amended", async () => {
    const name = "retune-race-own-user-stopped";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "cancelled", runStatus: "stopped", stopReason: "user" },
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(String(outcome.result.error?.message ?? "").startsWith("workflow_run_settled:")).toBe(
      true,
    );
  });
});

// docs/dynamic-workflow/launch.md "What the model is told": the three bullets say the **same**
// rule (omit to inherit the predecessor), with the script first — if the model believed the script
// were required, it would copy a several-thousand-token script again just to change one number.
// Since 2026-09-21 the description only carries routing (docs/dynamic-workflow/launch.md "What the
// model is told"): the carry-over rules' three-state fields, the ordering of the two sources, and
// the in-place-retune sentence moved into the dynamic-workflows skill's §16.4, guaranteed read by
// the skill gate; their order assertions live in bootstrap/tests/dynamic-workflow-skill.test.ts.
// This only pins the routing the description must still carry.
describe("AmendWorkflow — description", () => {
  it("routes: a settings-only revision names neither script field, resume is another tool", () => {
    const description = amendWorkflowToolEntry.metadata.description;
    expect(description).toContain("neither `path` nor `script`");
    // A stopped run continuing unchanged: that is ResumeWorkflowRun's job, not an empty amendment.
    expect(description).toContain("To continue a stopped run unchanged, use ResumeWorkflowRun");
    // Amend mid-run without stopping first or waiting for the end — the gate's boundary is written
    // here too: only a script needs the skill.
    expect(description).toContain("Do not TaskStop it first");
    expect(description).toContain("a settings-only call is not");
  });
});

// docs/dynamic-workflow/launch.md "Adjusting the settings in the window": only another session's
// run opens a window, and the adjustments in the window follow the same path as CreateWorkflow —
// the backfilled block, applied into the input after approval, and one sentence up front in the
// result.
describe("AmendWorkflow — settings adjusted in the confirmation window", () => {
  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: true },
    ],
  };

  it("the ask carries the adjustable_settings block next to the predecessor facts", async () => {
    const { port } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({ modelCatalogPort: CATALOG, name: "amend-adjustable", port });
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      max_concurrency: 2,
      adjustable_settings: { subagent_model: true, concurrency_ceiling: 8 },
    });
  });

  it("applies the adjustments to the amendment and names them in the result", async () => {
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({
      broker: {
        async requestPermission() {
          return {
            decision: "allow",
            inputAdjustments: { subagent_model: "gpt-5", max_concurrency: null },
          };
        },
      },
      modelCatalogPort: CATALOG,
      name: "amend-adjusted",
      port,
    });
    expect(amends).toHaveLength(1);
    expect(amends[0]!.subagentModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect("maxConcurrency" in amends[0]!).toBe(false);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain(
      "Before approving, the user adjusted the settings in the confirmation window: subagents run on openai/gpt-5 (the main agent stays on the session model); the limit on subagents at once is back to the default.",
    );
    expect(response).not.toContain("At most 2");
  });

  it("an own run amends without a window, so it carries the block but never an adjustment", async () => {
    const name = "amend-adjustable-owned";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
      defaultConcurrency: 8,
    });
    const outcome = await run({ name, port });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain(
      "Before approving",
    );
  });
});
