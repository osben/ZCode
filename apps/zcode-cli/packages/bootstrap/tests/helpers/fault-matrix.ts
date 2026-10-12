// ============================================================
// Per-cell assembly of the fault matrix (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Verification", "per-cell assertions")
// ============================================================
// One cell = one fake provider server + one script shape + one complete dwf run:
//   real compilation → sandboxed subprocess → engine → real driver (real governor + scaled
//   clock) → real AgentRuntime ×
//   each subagent → real AiSdkModelAdapter (tiny backoff) → real fetch → fake server.
// Two assembly levels:
//   - `runFaultCell`: driver level (`runDriverScript`), events straight into hand; the retry
//     rows and Stop-set rows use it;
//   - `createFaultServiceHarness`: run service level, going through the real submit / resume /
//     cancel paths; the lifecycle rows (resume after flip, stall, cancel during backoff) use it.
// Observation is collected uniformly in `FaultCellObservation`: settlement / RunEvent /
// ModelNetworkStatusEvent / actor session events / governor snapshot / journal / settlement
// time. `assertCommonInvariants` holds the six invariants asserted for every cell; per-row
// bounded counts are written by the matrix files themselves.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type DynamicWorkflowRunProgressPayload,
  type DynamicWorkflowRunSnapshot,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  InMemoryJournalStore,
  type JournalStorePort,
  type NodeRecord,
  type RunEvent,
  type RunSettlement,
  type RunStopReason,
} from "@zcode/dynamic-workflow";
import {
  createDynamicWorkflowRunService,
  type DynamicWorkflowRunService,
} from "../../src/app/dynamic-workflow-run-service.js";
import { workflowActorToolPolicy } from "../../src/app/workflow-actor-tools.js";
import {
  createWorkflowConcurrencyGovernor,
  type WorkflowConcurrencyGovernor,
} from "../../src/app/workflow-concurrency-governor.js";
import { WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR } from "../../src/app/workflow-default-concurrency.js";
import type { AgentRuntimeWorkflowDriverDeps } from "../../src/app/workflow-driver-types.js";
import {
  fakeFileSystemPort,
  runDriverScript,
  unsupportedExecutionPort,
} from "../workflow-driver.helpers.js";
import type { FakeProviderServer, WireFormat } from "./fake-provider-server.js";
import { FAULT_MATRIX_SHAPES, type ScriptShape, type ShapeSpec } from "./fault-matrix-scripts.js";
import {
  FAULT_CONCURRENCY_KEY,
  FAULT_MODEL_SELECTION,
  createFaultModelFactory,
} from "./fault-provider-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";

/**
 * The default governor default concurrency D: half of W16's subagents initially queue at the
 * gate (the spec's "parallelism axis"). The bucket can then grow to 2D through probing
 * (docs/dynamic-workflow/concurrency.md "The governor").
 */
export const FAULT_CELL_DEFAULT_CONCURRENCY = 8;
/** The default idle-turn count K per subagent (matches the fake server's canned model default; used only to compute logical request counts). */
export const FAULT_CELL_TURNS = 3;
/** The default clock scale: the driver's 2s→60s re-drive curve becomes 20ms→600ms. */
const FAULT_CELL_CLOCK_SCALE = 0.01;
/** The default stall window (**real** milliseconds); internally converted by the scale into the driver clock's virtual milliseconds. */
export const FAULT_CELL_STALL_AFTER_MS = 400;
/** The default wall-clock cap for the whole run (runWorkflowScript's timeoutMs). */
const FAULT_CELL_TIMEOUT_MS = 20_000;
/** The arrival grace still counted as "the tail from before the stop" after settlement: the magnitude of in-flight requests on the loopback interface, far smaller than the shortest retry wait. */
const STOP_WIRE_GRACE_MS = 10;

interface FaultCellOptions {
  server: FakeProviderServer;
  shape: ScriptShape;
  apiFormat: WireFormat;
  /** Governor default concurrency, default {@link FAULT_CELL_DEFAULT_CONCURRENCY}. */
  defaultConcurrency?: number;
  /** Stall window, **real** milliseconds, default {@link FAULT_CELL_STALL_AFTER_MS}. */
  stallAfterMs?: number;
  /** Driver clock scale, default {@link FAULT_CELL_CLOCK_SCALE}. */
  clockScale?: number;
  timeoutMs?: number;
  /** Idle-turn count K per subagent (informational: affects only `logicalRequests`), default {@link FAULT_CELL_TURNS}. */
  turns?: number;
}

export interface FaultCellObservation {
  runId: string;
  settlement: RunSettlement;
  events: RunEvent[];
  statusEvents: ModelNetworkStatusEvent[];
  /** All actor runtimes' session events (stream recovery markers etc. are found here). */
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  key: string;
  journal: InMemoryJournalStore;
  /** The moment settlement was observed (Date.now()). */
  settledAt: number;
  shape: ShapeSpec;
  /** Logical request count = asks × (K + 1); retries not counted. */
  logicalRequests: number;
}

/**
 * Scaled clock: virtual time passes at 1/scale speed; `schedule` converts a virtual delay into
 * a real delay by scale. `now` and `schedule` must be **on the same scale** — the stall clock
 * uses `now()` to re-check "has afterMs passed since the last success"; scaling only schedule
 * but not now would make it reschedule forever by the remaining amount. `stallAfterMs` is
 * therefore in virtual milliseconds.
 */
function makeScaledClock(input: {
  scale: number;
  /** Virtual milliseconds. */
  stallAfterMs: number;
}): NonNullable<AgentRuntimeWorkflowDriverDeps["clock"]> {
  const { scale } = input;
  return {
    now: () => Date.now() / scale,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, Math.max(1, Math.round(delayMs * scale)));
      return () => clearTimeout(timer);
    },
    // De-randomize the re-drive jitter (transientBackoffMs's random entry).
    random: () => 0.5,
    stallAfterMs: input.stallAfterMs,
  };
}

/** Counts one kind of ModelNetworkStatusEvent. */
export function statusCount(events: readonly ModelNetworkStatusEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

/** Filters RunEvents by type (with type narrowing). */
export function eventsOfType<T extends RunEvent["type"]>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

interface CellWiring {
  statusEvents: ModelNetworkStatusEvent[];
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  clock: NonNullable<AgentRuntimeWorkflowDriverDeps["clock"]>;
  model: ReturnType<typeof createFaultModelFactory>;
  fileSystemPort: ReturnType<typeof fakeFileSystemPort>;
  scale: number;
}

function wireCell(options: Omit<FaultCellOptions, "shape">): CellWiring {
  const statusEvents: ModelNetworkStatusEvent[] = [];
  const sessionEvents: SessionEvent[] = [];
  const statusSink: ModelStatusSink = {
    publish: (event) => {
      statusEvents.push(event);
    },
  };
  const scale = options.clockScale ?? FAULT_CELL_CLOCK_SCALE;
  return {
    statusEvents,
    sessionEvents,
    governor: createWorkflowConcurrencyGovernor({
      defaultConcurrency: options.defaultConcurrency ?? FAULT_CELL_DEFAULT_CONCURRENCY,
    }),
    clock: makeScaledClock({
      scale,
      stallAfterMs: (options.stallAfterMs ?? FAULT_CELL_STALL_AFTER_MS) / scale,
    }),
    model: createFaultModelFactory({
      apiFormat: options.apiFormat,
      baseURL: options.server.baseURL,
      statusSink,
    }),
    fileSystemPort: fakeFileSystemPort({}),
    scale,
  };
}

/** Builds an actor runtime: real model factory + request-level admission port + session event collection. */
function makeActorRuntime(
  wiring: CellWiring,
  input: {
    sessionId: Parameters<typeof createTestAgentRuntime>[0];
    persona: { system?: string; tools?: "default" | "readonly" | "none" };
    submitPort: unknown;
    escalatePort: unknown;
    modelRequestAdmission?: unknown;
  },
): AgentRuntime {
  return createTestAgentRuntime(
    input.sessionId,
    {
      systemPrompt: input.persona.system ?? "You are a workflow actor.",
      mode: "yolo",
      taskType: "workflow_child",
      subagents: { enabled: false },
      modelSelection: FAULT_MODEL_SELECTION,
      // The production runtime streams by default (the `?? "on"` in
      // zcode-protocol/workspace-model-runtime.ts); without it the turn goes through
      // generateText, and B7/B8's "cut mid-stream" degrades server-side into a connection reset,
      // never reaching decision 25's edge.
      modelStreaming: "on",
      ...workflowActorToolPolicy(input.persona as never),
    },
    {
      eventStore: createInMemorySessionEventStore(),
      eventSink: {
        onSessionEvent: (event) => {
          wiring.sessionEvents.push(event);
        },
      },
      modelFactory: wiring.model.modelFactory,
      workflowSubmitPort: input.submitPort as never,
      workflowEscalatePort: input.escalatePort as never,
      ...(input.modelRequestAdmission === undefined
        ? {}
        : { modelRequestAdmission: input.modelRequestAdmission as never }),
      fileSystemPort: wiring.fileSystemPort,
    },
  );
}

/** Driver level: runs one cell and returns the full observation. */
export async function runFaultCell(options: FaultCellOptions): Promise<FaultCellObservation> {
  const shape = FAULT_MATRIX_SHAPES[options.shape];
  const wiring = wireCell(options);
  const runId = `fault-${options.shape.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  try {
    const result = await runDriverScript(shape.script, {
      actorScripts: {},
      caps: { maxConcurrency: 16 },
      clock: wiring.clock,
      concurrency: wiring.governor,
      runId,
      runtimeFactory: ({ sessionId, persona, submitPort, escalatePort, modelRequestAdmission }) =>
        makeActorRuntime(wiring, {
          sessionId,
          persona,
          submitPort,
          escalatePort,
          modelRequestAdmission,
        }),
      timeoutMs: options.timeoutMs ?? FAULT_CELL_TIMEOUT_MS,
    });
    const settledAt = Date.now();
    return {
      runId,
      settlement: result.settlement,
      events: result.events,
      statusEvents: wiring.statusEvents,
      sessionEvents: wiring.sessionEvents,
      governor: wiring.governor,
      key: FAULT_CONCURRENCY_KEY,
      journal: result.journal,
      settledAt,
      shape,
      logicalRequests: shape.asks * ((options.turns ?? FAULT_CELL_TURNS) + 1),
    };
  } finally {
    wiring.model.dispose();
  }
}

// ————————————————————————————————————————————————————————————————
// run service level assembly
// ————————————————————————————————————————————————————————————————

export interface FaultServiceHarness {
  service: DynamicWorkflowRunService;
  /** The concrete type (not the narrow port): B18 hands it as-is to a second harness for reuse. */
  journal: InMemoryJournalStore;
  runEvents: DynamicWorkflowRunProgressPayload[];
  statusEvents: ModelNetworkStatusEvent[];
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  key: string;
  cwd: string;
  parentSessionId: string;
  /** Submits a shape and returns the runId (throws if the submission is rejected). */
  submit(shape: ScriptShape): Promise<string>;
  /** Waits for the run to settle and returns the snapshot. */
  settle(runId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /** The moment this run's `run-settled` progress event was observed; undefined if it never settled. */
  settledAt(runId: string): number | undefined;
  /** This run's RunEvent view (reconstructed as `{ type, ...payload }` from progress payloads). */
  eventsOf(runId: string): RunEvent[];
  dispose(): Promise<void>;
}

/** Extra inputs for the run-service-level assembly. */
interface FaultServiceHarnessOptions extends Omit<FaultCellOptions, "shape"> {
  /**
   * Reuse an existing journal (B18: after the first harness is stopped by close, the second
   * resumes **on the same journal** — exactly the shape of "the next activation"). By default
   * each harness starts its own in-memory journal.
   */
  journal?: InMemoryJournalStore;
}

/** The real run service: submit / resume / cancel all go through the product paths; the actor runtime is isomorphic to the driver level. */
export function createFaultServiceHarness(
  options: FaultServiceHarnessOptions,
): FaultServiceHarness {
  const wiring = wireCell(options);
  const journal = options.journal ?? new InMemoryJournalStore();
  const runEvents: DynamicWorkflowRunProgressPayload[] = [];
  const settledAtByRun = new Map<string, number>();
  const parentSessionId = `fault-parent-${randomUUID().slice(0, 8)}`;
  const cwd = mkdtempSync(join(tmpdir(), "dwf-fault-matrix-"));
  let submitted = 0;

  const service = createDynamicWorkflowRunService({
    concurrency: wiring.governor,
    createActorRuntime: (input) => {
      const runtime = makeActorRuntime(wiring, {
        sessionId: input.sessionId,
        persona: input.persona,
        submitPort: input.submitPort,
        escalatePort: input.escalatePort,
        modelRequestAdmission: input.modelRequestAdmission,
      });
      // The assembly has no session store, so a real resumeFromStore would throw a
      // configuration error. On the resume path, finished asks are replayed from the journal
      // and unfinished asks are re-asked in **brand-new** subagent sessions (terminal-states
      // decision 13); transcript hydration has no semantics here, so only "re-attach succeeds"
      // is pinned.
      runtime.resumeFromStore = async () => ({ resumed: true }) as never;
      return runtime;
    },
    driverClock: wiring.clock,
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: wiring.fileSystemPort,
    journal,
    onRunEvent: (progress) => {
      runEvents.push(progress);
      if (progress.eventType === "run-settled" && !settledAtByRun.has(progress.runId)) {
        settledAtByRun.set(progress.runId, Date.now());
      }
    },
    parentSessionId,
  });

  return {
    service,
    journal,
    runEvents,
    statusEvents: wiring.statusEvents,
    sessionEvents: wiring.sessionEvents,
    governor: wiring.governor,
    key: FAULT_CONCURRENCY_KEY,
    cwd,
    parentSessionId,
    async submit(shape) {
      submitted += 1;
      const name = `fault-${shape.toLowerCase()}-${submitted}`;
      const sessionId = createSessionId(parentSessionId);
      const result = await service.submit({
        cwd,
        parentSessionId,
        scriptText: FAULT_MATRIX_SHAPES[shape].script,
        toolCallId: createToolCallId(`${name}-call`),
        trace: createRootTraceContext({ sessionId, turnId: createTurnId(name) }),
      });
      if (!result.ok) throw new Error(`fault matrix submit refused: ${result.reason}`);
      return result.runId;
    },
    settle(runId) {
      return service.waitForTask(runId);
    },
    settledAt(runId) {
      return settledAtByRun.get(runId);
    },
    eventsOf(runId) {
      return runEvents
        .filter((progress) => progress.runId === runId)
        .map((progress) => ({ type: progress.eventType, ...progress.payload }) as RunEvent);
    },
    async dispose() {
      wiring.model.dispose();
    },
  };
}

// ————————————————————————————————————————————————————————————————
// Common invariants
// ————————————————————————————————————————————————————————————————

interface CommonInvariantExpectation {
  status: "completed" | "stopped" | "errored";
  stopReason?: RunStopReason;
  server: FakeProviderServer;
  /** Governor default concurrency, default {@link FAULT_CELL_DEFAULT_CONCURRENCY}. */
  defaultConcurrency?: number;
  /** The canned model's submit payload (compared node by node for completed cells); default `{ note: "done" }`. */
  submitPayload?: unknown;
}

/** This run's ask node rows. */
export function askNodes(journal: JournalStorePort, runId: string): NodeRecord[] {
  return journal
    .listNodes(runId, { kinds: "all", withResult: true })
    .filter((node) => node.siteId.startsWith("ask#"));
}

/**
 * The six asserted for every cell (spec "per-cell assertions" 1–6):
 *   1 terminal state as stated; 2 no subagent lost; 3 the script never sees a model error;
 *   4 event syntax; 5 zero requests after the stop; 6 in-flight bound.
 */
export function assertCommonInvariants(
  observation: Pick<
    FaultCellObservation,
    "runId" | "settlement" | "events" | "statusEvents" | "settledAt"
  > & { journal: JournalStorePort },
  expectation: CommonInvariantExpectation,
): void {
  const { runId, settlement, events, statusEvents, journal, settledAt } = observation;
  const { server } = expectation;

  // 1 Terminal state
  expect(settlement.status).toBe(expectation.status);
  if (expectation.stopReason !== undefined) {
    expect(settlement.status === "stopped" ? settlement.reason : undefined).toBe(
      expectation.stopReason,
    );
  }
  expect(journal.getRun(runId)?.status).toBe(expectation.status);

  // 2 No subagent lost
  const nodes = askNodes(journal, runId);
  expect(nodes.length).toBeGreaterThan(0);
  if (expectation.status === "completed") {
    for (const node of nodes) {
      expect(node.status, `ask node ${node.siteId}@${node.ordinal}`).toBe("completed");
      expect(node.result).toEqual(expectation.submitPayload ?? { note: "done" });
    }
  } else {
    // In-flight nodes at stop time do not land in the journal (scheduler.abortInFlight only
    // emits node-settled(cancelled)), so row status can only be completed (already finished) or
    // running (aborted); never failed.
    for (const node of nodes) {
      expect(["completed", "running"], `ask node ${node.siteId}@${node.ordinal}`).toContain(
        node.status,
      );
    }
  }

  // 3 The script never sees a model error: no failed node settlements, and no DriverError in the journal.
  const failedSettlements = eventsOfType(events, "node-settled").filter(
    (event) => event.outcome === "failed",
  );
  expect(failedSettlements).toEqual([]);
  const run = journal.getRun(runId);
  expect(run?.failure?.code).not.toBe("DriverError");

  // 4 Event syntax: after every retryable failure there is a retry_scheduled on the same
  // requestId; non-retryable failures are only allowed in stopped(provider) cells.
  const failed = statusEvents.filter(
    (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
      event.type === "model_request_failed",
  );
  const scheduledByRequest = new Map<string, number>();
  for (const event of statusEvents) {
    if (event.type !== "model_retry_scheduled") continue;
    scheduledByRequest.set(event.requestId, (scheduledByRequest.get(event.requestId) ?? 0) + 1);
  }
  const retryableFailed = failed.filter((event) => event.retryable);
  for (const event of retryableFailed) {
    expect(
      scheduledByRequest.get(event.requestId) ?? 0,
      `retryable failure ${event.requestId} (${event.reason}) has a retry_scheduled`,
    ).toBeGreaterThan(0);
  }
  // A stream failure after visible output is the runner layer's "no replay" (adaptive-concurrency
  // decision 25): it is reported with `retryable:false` + `streamOutputCommitted:true`, and what
  // takes over is core's stream recovery rather than the runner's retry, so it does not count as
  // a terminal failure — the two B8 rows assert it specifically.
  // When a sibling is aborted the runner reports a failed with `reason:"cancelled"` — that is
  // the echo of cancellation, not the provider's terminal failure, present in any stopped cell.
  const terminalFailed = failed.filter(
    (event) =>
      !event.retryable && event.streamOutputCommitted !== true && event.reason !== "cancelled",
  );
  if (!(expectation.status === "stopped" && expectation.stopReason === "provider")) {
    expect(terminalFailed).toEqual([]);
  }

  // 5 Zero requests after the stop. The engine's stop() aborts in-flight nodes before settling,
  // but the fake server and the client share one event loop: a request already written to the
  // loopback interface before the abort only gets its "arrival" stamp from the server's handler
  // after the settlement's chain of synchronous work (journal, notification, sibling aborts)
  // completes — under heavy load it can arrive a dozen-plus ms late. That is not new work after
  // the stop, it is the tail from before the stop, and the runner will report it as
  // `reason:"cancelled"`. Therefore: every late request beyond the grace must match one
  // cancelled echo; a request fired by a backoff timer that was never cancelled will not be
  // reported as cancelled by the runner and is caught all the same.
  const late = server.requests.filter((entry) => entry.at > settledAt + STOP_WIRE_GRACE_MS);
  const cancelledEchoes = failed.filter((event) => event.reason === "cancelled").length;
  expect(
    late.length,
    `requests arriving after run-settled (${late.length}) must all be cancel echoes (${cancelledEchoes})`,
  ).toBeLessThanOrEqual(cancelledEchoes);

  // 6 In-flight bound: the governor's growth cap. The cell's run runs at the default bound and
  // does not raise it, so it is 2D.
  expect(server.inFlightPeak).toBeLessThanOrEqual(
    WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR *
      (expectation.defaultConcurrency ?? FAULT_CELL_DEFAULT_CONCURRENCY),
  );
}

/** Waits a short real time (used to re-check "zero requests" after settlement). */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
