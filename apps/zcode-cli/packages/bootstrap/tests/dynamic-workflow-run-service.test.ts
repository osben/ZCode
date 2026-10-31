/**
 * Integration tests for the dwf run service. Assembled like runDriverScript in workflow-driver.helpers.ts: real script →
 * real compile / schema synthesis / validate / lowering → sandbox subprocess → engine core → real AgentRuntime
 * driver, with only the model swapped for a predictable scripted adapter. The system under test is the run service itself:
 * compile once, engine-exclusive createRun, run metadata persisted, actor sessions materialized, cancel semantics, caps defaults, event paging.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgentRuntime, createTestModelSelection } from "./helpers/test-agent-runtime.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import type {
  DwfArtifactItem,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
  DwfRunSessionListItem,
} from "@zcode/adapters/storage";
import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  LIST_WORKFLOW_RUNS_MAX_LIMIT,
  type CollaborationMode,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunDetail,
  type DynamicWorkflowRunListQuery,
  type DynamicWorkflowRunListResult,
  type DynamicWorkflowRunProgressPayload,
  type MessageWithParts,
  type ModelSelection,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type ToolArtifactWriteRequest,
  type WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  AgentRuntime,
  PermissionService,
  builtInTools,
  createToolExecutor,
  createToolRegistry,
  defaultPermissionConfig,
} from "@zcode/core";
import {
  reduceWorkflowRunsState,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  workflowRunsStateSchema,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  holeSiteId,
  InMemoryJournalStore,
  refToString,
  type JournalStorePort,
  type NodeRecord,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type RunStopReason,
} from "@zcode/dynamic-workflow";

import {
  createDynamicWorkflowRunService,
  resolveDynamicWorkflowJournalStore,
  type DynamicWorkflowActorRuntimeInput,
} from "../src/app/dynamic-workflow-run-service.js";
import {
  createWorkflowConcurrencyGovernor,
  type WorkflowConcurrencyPort,
} from "../src/app/workflow-concurrency-governor.js";
import { resolveWorkflowDefaultConcurrency } from "../src/app/workflow-default-concurrency.js";
import { replayRunProgress } from "../src/app/dynamic-workflow-run-replay.js";
import { workflowActorModelPolicy } from "../src/app/workflow-actor-model.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  WORKFLOW_QUOTA_RESUME_MARGIN_MS,
  startWorkflowQuotaAutoResume,
} from "../src/app/dynamic-workflow-quota-resume.js";
import {
  fakeFileSystemPort,
  unsupportedExecutionPort,
  type PlannedResponse,
} from "./workflow-driver.helpers.js";
import type { ExecutionPort } from "@zcode/contracts";
import { mkdtempSync, readFileSync } from "node:fs";
/**
 * A dedicated run cwd: the harness writes the entry file to `<cwd>/.zcode/workflow-runs/<runId>.mjs` and keeps it;
 * using process.cwd() would leave archives inside the package dir and let parallel test files overwrite each other's same-named entry files.
 */
const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-bootstrap-test-cwd-"));

// Counts how many real ts.Program instances were built, making "compile once" an assertable fact.
// importOriginal keeps the compilation itself real — the remaining cases depend on real lowering and schema synthesis.
const { compiledScripts } = vi.hoisted(() => ({ compiledScripts: [] as string[] }));

vi.mock("@zcode/dynamic-workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/dynamic-workflow")>();
  return {
    ...actual,
    createWorkflowProgram: (scriptText: string) => {
      compiledScripts.push(scriptText);
      return actual.createWorkflowProgram(scriptText);
    },
  };
});

/** Minimal script with one typed ask; actor ref actor#1@1, ask site ask#1. */
const TYPED_SCRIPT = [
  "interface Answer { text: string }",
  'const a = await agent("worker").ask<Answer>("do the thing");',
  "return a.text;",
].join("\n");

const BROKEN_SCRIPT = 'const x: number = "definitely not a number";';

/**
 * Publish a user-facing artifact (docs/dynamic-workflow/authoring.md). markdown rather than file: this case
 * proves the **wiring** (service → launch → driver → store), and markdown needs no real file in the workspace —
 * the file side's path / limit / type semantics belong to workflow-driver-artifacts.test.ts.
 */
const ARTIFACT_SCRIPT = ['artifact.markdown("summary", "# 结论");', 'return "done";'].join("\n");

function traceFor(name: string) {
  const sessionId = createSessionId(name);
  return createRootTraceContext({ sessionId, turnId: createTurnId(name) });
}

/**
 * This file's model plans add one kind over the helpers': `escalate` issues a real `escalate` tool call.
 * It runs the whole "actor hits a wall → asks → gets an answer → keeps working" chain through the **real tool layer**,
 * instead of the test holding a port and playing the model (which would skip the registration gate, allowlist re-adding, and tool-result feeding).
 */
type ActorPlan =
  | PlannedResponse
  | { kind: "escalate"; question: string; context?: string }
  // One real `Write` tool call: runs the "subagent writes file → executor emits ToolCallStarted → driver reports → engine closes the import cache"
  // chain through the real tool layer (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Amend-resume").
  | { kind: "write"; path: string; content: string }
  // Hangs, but **honors cancellation**: the turn rejects with the abort signal, like a real provider.
  //
  // The difference from `hang` is not a detail but a watershed: `hang` simulates a provider that ignores even the AbortSignal;
  // its turn never lands, so "did it finish writing" is forever unanswerable (the driver's quiescence ledger therefore
  // refuses to continue its in-flight ask, see workflow-driver-quiescence.ts). This kind is the normal shape.
  | { kind: "hang-until-cancelled" }
  // The model request rejects with an adapter error (model-side error containment case).
  | { kind: "throw"; error: unknown };

/** Observation surface of one generateText request: the messages the model saw this round and the tools offered. */
interface ModelRequestLog {
  requests: { messages?: unknown; tools?: readonly { name: string }[] }[];
}

/** Scripted model adapter (same pattern as workflow-driver.helpers; this file keys plans by actor). */
function scriptedModelAdapter(
  responses: ActorPlan[],
  onCall?: () => void,
  log?: ModelRequestLog,
): unknown {
  let index = 0;
  return {
    async generateText(request?: {
      abortSignal?: AbortSignal;
      messages?: unknown;
      tools?: readonly { name: string }[];
    }) {
      onCall?.();
      log?.requests.push({ messages: request?.messages, tools: request?.tools });
      const planned: ActorPlan = responses[index++] ?? {
        kind: "text",
        text: "(no further scripted response)",
      };
      // Hang: simulates an in-flight turn (cancel/resume cases use it to stop the run at a predictable point).
      if (planned.kind === "hang") return new Promise(() => {});
      if (planned.kind === "hang-until-cancelled") {
        const signal = request?.abortSignal;
        // Without a signal it degrades to a hang (must not happen: the driver builds an AbortController per ask).
        if (signal === undefined) return new Promise(() => {});
        return new Promise((_resolve, reject) => {
          const fail = (): void => reject(new Error("model request aborted"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (planned.kind === "throw") throw planned.error;
      const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
      if (planned.kind === "submit") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `submit-call-${index}`,
              name: SUBMIT_RESULT_TOOL_NAME,
              input: { result: planned.result },
            },
          ],
          usage,
        };
      }
      if (planned.kind === "write") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `write-call-${index}`,
              name: "Write",
              input: { file_path: planned.path, content: planned.content },
            },
          ],
          usage,
        };
      }
      if (planned.kind === "escalate") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `escalate-call-${index}`,
              name: ESCALATE_TOOL_NAME,
              input: {
                question: planned.question,
                ...(planned.context === undefined ? {} : { context: planned.context }),
              },
            },
          ],
          usage,
        };
      }
      return {
        finishReason: "stop",
        model: "scripted",
        providerMetadata: undefined,
        text: planned.text,
        usage,
      };
    },
  };
}

interface HarnessOptions {
  actorScripts?: Record<string, ActorPlan[]>;
  availableParallelism?: () => number;
  /** Narrow port of the process-level governor; not wired by default (actors ungated, launch registers no ceiling). */
  concurrency?: WorkflowConcurrencyPort;
  journal?: JournalStorePort;
  /** Keeps an actor runtime's turn from ever finishing on its own; for cancel cases. */
  hangActors?: boolean;
  actorCleanup?: () => Promise<void>;
  /**
   * Bounded wait ceiling for session quiescence (default {@link AMEND_TRANSCRIPT_QUIESCE_MS} = 5s). Only the path
   * "amending an in-flight predecessor whose turn cannot land" actually waits the full span, so only that case group needs it shortened.
   */
  quiesceMs?: number;
  onRunEvent?: (progress: DynamicWorkflowRunProgressPayload) => void;
  /** Parent session's current permission mode (docs/dynamic-workflow/launch.md "Permissions inside a run"); not wired by default. */
  permissionMode?: () => CollaborationMode;
  /** Parent session of this service instance (the scope of orphan convergence). */
  parentSessionId?: string;
  /**
   * Residency registration hook (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership" rule 1).
   * **Not wired by default**: every other case in this file thereby doubles as a regression for "behavior unchanged when the host has no residency concept".
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /** Origin anchor resolution (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Token telemetry for subagents"): default means the host has no active turn. */
  resolveLaunchInputId?: (trace: { turnId?: string }) => string | undefined;
  /** Makes resumeFromStore throw SessionNotFound (fallback case for a cleaned-up session). */
  resumeSessionMissing?: boolean;
  /**
   * Real session store: wiring it makes actor messages actually persist and lets the service hand the transcript face to the driver
   * (the premise of ask-boundary bookkeeping, apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md). Not wired by default.
   */
  sessionStore?: SessionStorePort;
  /** Landing spot for user-facing artifacts. Not wired by default — content members are rejected with ArtifactStoreUnavailable. */
  artifactStore?: ToolArtifactStorePort;
  taskLinkStore?: { createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<unknown> };
  /** Injection point that mints a draft when completion lands on a draft-less run (the hole-filling cases); not wired by default. */
  writeWorkflowDraft?: Parameters<typeof createDynamicWorkflowRunService>[0]["writeWorkflowDraft"];
  /** Execution port for world.run; touching it fails by default (most cases in this file must not run commands). */
  executionPort?: ExecutionPort;
}

interface Harness {
  /** Event store shared by actor runtimes (in production, the **parent runtime's** store). */
  actorEventStore: SessionEventStorePort;
  /** Per-actor model request ledger (keyed by actor ref string); observation surface for tool faces and tool results. */
  actorModelRequests: Record<string, ModelRequestLog>;
  actorRuntimeInputs: DynamicWorkflowActorRuntimeInput[];
  /**
   * Sessions that called subscribeEvents on an actor runtime. The run service itself must **never** (old dead seam);
   * the driver subscribes exactly once per actor for rate-limit observation (docs/dynamic-workflow/concurrency.md "Protocol and UI"),
   * and that subscription reads only ModelNetworkStatus — it is not a live transcript channel.
   */
  actorSubscribeCalls: SessionId[];
  journal: JournalStorePort;
  /** Logs recorded by the service (orphan convergence requires a warn per entry). */
  logs: { level: string; message: string; context?: Record<string, unknown> }[];
  /** Per-actor **ordering** of construction/persistence/live-wiring/subscription/first model call. */
  order: string[];
  persistedTitles: string[];
  /** Actor sessions resumeFromStore was called on (observation surface of the rehydration cases). */
  resumeCalls: SessionId[];
  runEvents: DynamicWorkflowRunProgressPayload[];
  runEventRoutings: { parentSessionId?: string }[];
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  sessionEvents: unknown[];
  taskLinks: CreateSessionTaskLinkInput[];
}

/** Default parent session for this service instance; orphan-convergence cases contrast it with "other sessions". */
const HARNESS_PARENT_SESSION = createSessionId("harness-parent");
/**
 * The harness's "parent session's current model": the same value as createTestAgentRuntime's default selection, so
 * "not overridden" and "overridden to the parent model" land on the same record here — mirroring production (create-app.ts passes
 * `getRuntime().getSessionModelSelection()` to the model strategy as parentSelection).
 */
const HARNESS_PARENT_MODEL = createTestModelSelection("test/default-runtime-model");

/**
 * Journal stand-in with the orphan-convergence narrow query. The real SQL semantics (pre-filtering non-terminal rows by
 * parent session) are pinned against the real database in `adapters/tests/dwf-journal-store.test.ts`; here we only need an
 * implementation the run service's capability probe recognizes, so the "what converges, what write fails" policy layer can be asserted in isolation.
 */
class SweepableJournalStore extends InMemoryJournalStore {
  private readonly createdRunIds: string[] = [];
  /** Stand-in for row timestamps: the real DB maintains time_created/time_updated via SQL; the in-memory version carries none. */
  private readonly rowTimes = new Map<string, number>();
  private clock = 1_700_000_000_000;

  override createRun(record: RunRecord): void {
    super.createRun(record);
    this.createdRunIds.push(record.runId);
    // Increment one millisecond per row: makes "most recently updated first" an assertable fact even in the stand-in.
    this.clock += 1;
    this.rowTimes.set(record.runId, this.clock);
  }

  /** A row's stand-in timestamp (tests assert updatedAt pass-through from it). */
  rowTimeOf(runId: string): number {
    const time = this.rowTimes.get(runId);
    if (time === undefined) throw new Error(`no row time for ${runId}`);
    return time;
  }

  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    return this.createdRunIds
      .map((runId) => this.getRun(runId))
      .filter(
        (run): run is RunRecord =>
          run !== undefined &&
          run.parentSessionId === parentSessionId &&
          !["completed", "errored", "stopped"].includes(run.status),
      );
  }

  /**
   * Enumeration stand-in: reversed creation order approximates "most recently updated first"; the real SQL ordering is pinned on the adapters side.
   * Returns the narrow projection + timestamps ({@link DwfRunSessionListItem}) — `result` deliberately omitted, same rule
   * as the real DB not selecting result_json.
   */
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return this.createdRunIds
      .map((runId) => this.getRun(runId))
      .filter(
        (run): run is RunRecord => run !== undefined && run.parentSessionId === parentSessionId,
      )
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((run) => {
        const { result: _result, ...rest } = run;
        return {
          ...rest,
          timeCreated: this.rowTimeOf(run.runId),
          timeUpdated: this.rowTimeOf(run.runId),
        };
      });
  }

  /**
   * Artifact read-face stand-in (the real DB's two SQL statements are pinned on the adapters side; only the **semantics** must match here).
   *
   * `listArtifactRows` = the run's `kind = "artifact"` node rows in insertion order (= version order).
   * **Includes failed rows**: callers filter by status themselves — the "a failed publish does not count as a version" ruling
   * belongs to the read side; having the storage layer do it would leave nothing to test.
   */
  listArtifactRows(runId: string): NodeRecord[] {
    return this.listNodes(runId, { kinds: "all", withResult: true }).filter(
      (node) => node.kind === "artifact",
    );
  }

  /**
   * `listArtifactItems` = the run's `type = "report"` **event** rows matching `artifactId`,
   * one page in ascending sequence. `limit` is honored **exactly** and never clamped (same as the real DB); `hasMore` is decided here.
   * Byte bounds are not simulated in the stand-in — the real DB's byte rules are pinned by adapters tests.
   */
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: { afterSequence?: number; limit: number; maxBytes: number },
  ): { items: DwfArtifactItem[]; hasMore: boolean } {
    if (query.limit <= 0) return { items: [], hasMore: false };
    const after = query.afterSequence ?? -1;
    const items: DwfArtifactItem[] = [];
    for (const stored of this.listEvents(runId, { types: "all", reportItems: "all" })) {
      if (stored.sequence <= after) continue;
      const event = stored.event as {
        type?: string;
        instance?: unknown;
        item?: unknown;
        artifactId?: unknown;
      };
      if (event.type !== "report" || event.artifactId !== artifactId) continue;
      if (items.length >= query.limit) return { items, hasMore: true };
      const instance = event.instance as { siteId?: string; ordinal?: number } | undefined;
      items.push({
        item: event.item,
        ordinal: instance?.ordinal ?? 0,
        sequence: stored.sequence,
        siteId: instance?.siteId ?? "report#1",
      });
    }
    return { items, hasMore: false };
  }
}

/** Pre-seed one dwf_run row (simulating a record left by a previous process). */
function preloadRun(
  journal: JournalStorePort,
  input: {
    spentTokens?: number;
    caps?: { maxConcurrency: number };
    cwd?: string;
    failure?: { code: string; message: string };
    name?: string;
    parentSessionId?: string;
    result?: unknown;
    runId: string;
    scriptText?: string;
    status: RunStatus;
    stopReason?: RunStopReason;
  },
): void {
  journal.createRun({
    runId: input.runId,
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
    ...(input.failure === undefined ? {} : { failure: input.failure as never }),
    ...("result" in input ? { result: input.result } : {}),
    caps: input.caps ?? { maxConcurrency: 4 },
    spentTokens: input.spentTokens ?? 0,
    status: input.status,
  });
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const journal = options.journal ?? new SweepableJournalStore();
  const actorRuntimeInputs: DynamicWorkflowActorRuntimeInput[] = [];
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const persistedTitles: string[] = [];
  const runEvents: DynamicWorkflowRunProgressPayload[] = [];
  const runEventRoutings: { parentSessionId?: string }[] = [];
  const sessionEvents: unknown[] = [];
  const actorSubscribeCalls: SessionId[] = [];
  const resumeCalls: SessionId[] = [];
  const actorEventStore = createInMemorySessionEventStore();
  const taskLinks: CreateSessionTaskLinkInput[] = [];
  const order: string[] = [];
  const actorModelRequests: Record<string, ModelRequestLog> = {};

  const fileSystemPort = fakeFileSystemPort({});
  const logger = {
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "debug", message, context }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
  };

  const service = createDynamicWorkflowRunService({
    ...(options.availableParallelism ? { availableParallelism: options.availableParallelism } : {}),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.resolveLaunchInputId === undefined
      ? {}
      : { resolveLaunchInputId: options.resolveLaunchInputId }),
    ...(options.sessionStore === undefined ? {} : { actorTranscriptStore: options.sessionStore }),
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    // Only to shrink the bounded wait for "session quiescence" to milliseconds (the gate for amend
    // continuing an in-flight ask, see workflow-driver-quiescence.ts). All other driver clock behavior uses real time.
    ...(options.quiesceMs === undefined ? {} : { driverClock: { quiesceMs: options.quiesceMs } }),
    createActorRuntime: (input) => {
      actorRuntimeInputs.push(input);
      const key = refToString(input.actor);
      const responses: ActorPlan[] = options.hangActors
        ? []
        : (options.actorScripts?.[key] ?? [{ kind: "submit", result: { text: "done" } }]);
      order.push(`construct:${key}`);
      const modelRequests: ModelRequestLog = { requests: [] };
      actorModelRequests[key] = modelRequests;
      const runtime = createTestAgentRuntime(
        input.sessionId,
        {
          systemPrompt: input.persona.system ?? "You are a workflow actor.",
          mode: "yolo",
          taskType: "workflow_child",
          subagents: { enabled: false },
          ...workflowActorToolPolicy(input.persona),
          // The model face unfolds like the production factory (create-app.ts): pin and this run's subagentModel both enter the strategy,
          // so the selection the runtime actually gets is the one journaled as journalActorResolvedModel. Without this layer,
          // "which source wins" would only be visible at factory-input level in run service tests, not in what lands in the journal.
          ...workflowActorModelPolicy(
            {
              parentSelection: HARNESS_PARENT_MODEL,
              ...(input.runSubagentModel === undefined
                ? {}
                : { runSelection: input.runSubagentModel }),
              ...(input.actorModel === undefined ? {} : { actorSelection: input.actorModel }),
            },
            input.pinnedModel,
          ).configOverrides,
        },
        {
          // Two essentials of the production wiring, per script-workflow-child-runtime.ts:
          // (1) the event store is shared with the parent runtime (a harness-level store stands in for the parent's);
          // (2) the live sink is a **construction-time** dep, not a later subscribeEvents.
          eventStore: actorEventStore,
          eventSink: {
            onSessionEvent: (event) => {
              if (sessionEvents.length === 0) order.push("sink");
              sessionEvents.push(event);
            },
          },
          modelAdapter: (options.hangActors
            ? {
                // Mimic a real adapter: end the request on cancel, or the new close contract would correctly wait on it forever.
                generateText: (request: { abortSignal?: AbortSignal }) =>
                  new Promise((_resolve, reject) => {
                    const signal = request.abortSignal;
                    if (signal?.aborted) reject(signal.reason);
                    else
                      signal?.addEventListener("abort", () => reject(signal.reason), {
                        once: true,
                      });
                  }),
              }
            : scriptedModelAdapter(
                responses,
                () => order.push(`turn:${refToString(input.actor)}`),
                modelRequests,
              )) as never,
          workflowSubmitPort: input.submitPort,
          // Per production (script-workflow-child-runtime.ts): both control ports enter the actor session together.
          // Port presence = `escalate` enters the registry — the sole switch for the actor-side escalation channel.
          workflowEscalatePort: input.escalatePort,
          fileSystemPort,
          ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
        },
      );
      // The old dead seam: the run service used to subscribeEvents after persist as a live transcript channel. That must
      // never happen again (a subscription installed after seq 1 makes the v4 gateway wait for seq 1 forever). Today's
      // subscribers are only the driver's two observation faces (once per actor: rate-limit observation reads
      // ModelNetworkStatus, tool-activity observation reads ToolCallStarted); the cases below count on that.
      if (options.actorCleanup) {
        const closeBrowserSession = runtime.closeBrowserSession.bind(runtime);
        runtime.closeBrowserSession = async () => {
          await closeBrowserSession();
          await options.actorCleanup!();
        };
      }
      const originalSubscribe = runtime.subscribeEvents.bind(runtime);
      runtime.subscribeEvents = (sink) => {
        actorSubscribeCalls.push(input.sessionId);
        return originalSubscribe(sink);
      };
      // ensureSessionPersistedForExternalActivity is a no-op without a sessionStore,
      // so wrap it to record the call fact (ordering assertions rely on its position relative to taskLinks).
      const original = runtime.ensureSessionPersistedForExternalActivity.bind(runtime);
      runtime.ensureSessionPersistedForExternalActivity = async (title, opts) => {
        persistedTitles.push(title);
        order.push(`persist:${key}`);
        return original(title, opts);
      };
      // Full resumeFromStore stand-in (does not call original): the harness runtime has no sessionStore,
      // so the real implementation would throw a config error. This only pins "rehydration called / not called" and the fallback path;
      // the real messageHistory hydration semantics are covered by core's resume tests.
      runtime.resumeFromStore = async () => {
        order.push(`resume:${key}`);
        resumeCalls.push(input.sessionId);
        if (options.resumeSessionMissing) {
          const gone = new Error("session not found (harness)");
          (gone as unknown as { type: unknown }).type = CoreErrorType.SessionNotFound;
          throw gone;
        }
        return { resumed: true } as never;
      };
      return runtime;
    },
    executionPort: options.executionPort ?? unsupportedExecutionPort(),
    fileSystemPort,
    journal,
    logger: logger as never,
    onRunEvent: (progress, routing) => {
      runEvents.push(progress);
      runEventRoutings.push(routing);
      options.onRunEvent?.(progress);
    },
    parentSessionId: options.parentSessionId ?? HARNESS_PARENT_SESSION,
    ...(options.writeWorkflowDraft === undefined
      ? {}
      : { writeWorkflowDraft: options.writeWorkflowDraft }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: options.registerResidencyBlockingWork }),
    ...(options.taskLinkStore
      ? { taskLinkStore: options.taskLinkStore }
      : {
          taskLinkStore: {
            async createSessionTaskLink(input) {
              order.push(`link:${input.childSessionId}`);
              taskLinks.push(input);
              return input;
            },
          },
        }),
  });

  return {
    actorEventStore,
    actorModelRequests,
    actorRuntimeInputs,
    actorSubscribeCalls,
    journal,
    logs,
    order,
    persistedTitles,
    resumeCalls,
    runEventRoutings,
    runEvents,
    service,
    sessionEvents,
    taskLinks,
  };
}

/**
 * Submit, assert acceptance, return the runId. submit's result is a discriminated union (amend-resume's three gates can
 * reject a submission, see DynamicWorkflowRunSubmitResult in contracts), so "submission accepted" must be established first
 * in every case; centralizing that assertion here keeps case bodies from each writing if (!result.ok).
 * Rejection paths are asserted directly against service.submit in the amend case group.
 */
async function submitRun(
  harness: Harness,
  request: Parameters<Harness["service"]["submit"]>[0],
): Promise<string> {
  const result = await harness.service.submit(request);
  return result.runId;
}

/** The amend entry's success path (refusals are asserted in dedicated cases). */
async function amendRun(
  harness: Harness,
  request: Parameters<NonNullable<Harness["service"]["amend"]>>[0],
): Promise<{ runId: string; supersededRunId?: string }> {
  const result = await harness.service.amend!(request);
  if (!result.ok) throw new Error(`amend refused unexpectedly: ${result.reason}`);
  return result;
}

/** Wait for a run to settle (waitForTask is the port's own waiting face, incidentally covered by these cases). */
async function settle(harness: Harness, runId: string): Promise<void> {
  await harness.service.waitForTask(runId);
}

describe("dynamic workflow run service — 在飞计数与结算订阅（registry 安全边界的读面）", () => {
  it("submit 后 countLiveRuns 为 1；结算后归零，监听器恰好收到一次、计数已扣掉本 run", async () => {
    const harness = makeHarness();
    const notices: { runId: string; liveRunCount: number }[] = [];
    const unsubscribe = harness.service.subscribeRunSettled((notice) => {
      notices.push(notice);
    });

    expect(harness.service.countLiveRuns()).toBe(0);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("live-count-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("live-count-call"),
      trace: traceFor("live-count"),
    });
    expect(harness.service.countLiveRuns()).toBe(1);
    expect(notices).toEqual([]);

    await settle(harness, runId);

    expect(harness.service.countLiveRuns()).toBe(0);
    expect(notices).toEqual([{ runId, liveRunCount: 0 }]);

    // Run another run after unsubscribing: no more notifications, but counting continues.
    unsubscribe();
    const second = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("live-count-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("live-count-call-2"),
      trace: traceFor("live-count-2"),
    });
    await settle(harness, second);
    expect(notices).toHaveLength(1);
    expect(harness.service.countLiveRuns()).toBe(0);
  });

  it("监听器抛错只记日志，不影响结算与其他监听器", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.service.subscribeRunSettled(() => {
      throw new Error("listener boom");
    });
    harness.service.subscribeRunSettled((notice) => {
      seen.push(notice.runId);
    });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("listener-throw-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("listener-throw-call"),
      trace: traceFor("listener-throw"),
    });
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    expect(seen).toEqual([runId]);
    expect(
      harness.logs.some(
        (log) =>
          log.level === "warn" &&
          log.context?.event === "dynamic_workflow.run.settled_listener_failed",
      ),
    ).toBe(true);
  });
});

/**
 * Residency registration (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership" rule 1).
 *
 * Bug root cause (2026-09-15): the engine lived inside the session App's closure and never entered the runtime task
 * registry, while the residency pool reads only the registry — a still-running run read as idle, the App closed
 * (10-minute idle), and resume started a second engine.
 * Registration must land in the **same synchronous slice as launch**, so both cases below assert **before** awaiting the entry promise.
 */
describe("dynamic workflow run service — 常驻登记（Engine ownership 规则一）", () => {
  /** Records registered promises and whether they settled; the latter proves the registration is not the placeholder promise on a registry entry. */
  function recorder(): {
    register: (work: Promise<unknown>) => void;
    settled: boolean[];
    works: Promise<unknown>[];
  } {
    const works: Promise<unknown>[] = [];
    const settled: boolean[] = [];
    return {
      settled,
      works,
      register: (work: Promise<unknown>) => {
        const index = works.push(work) - 1;
        settled[index] = false;
        void work.then(() => {
          settled[index] = true;
        });
      },
    };
  }

  it("submit 在同一同步片登记恰好一次，登记的 promise 随 run 结算解除", async () => {
    const hook = recorder();
    const harness = makeHarness({ registerResidencyBlockingWork: hook.register });

    const submitted = harness.service.submit({
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("residency-submit"),
    });
    // The submit promise is not yet awaited and registration already happened: residency rebalancing landing here can see this run.
    expect(hook.works).toHaveLength(1);

    const runId = (await submitted).runId;
    // What is registered is the real settlement promise, not the synchronously visible placeholder Promise.resolve on the entry.
    expect(hook.settled[0]).toBe(false);
    expect(harness.service.countLiveRuns()).toBe(1);

    await settle(harness, runId);
    await hook.works[0];
    expect(hook.settled[0]).toBe(true);
    // Exactly once: submit goes through trackSettlement as the single registration point.
    expect(hook.works).toHaveLength(1);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
  });

  it("resume 同样在同一同步片登记一次（登记的是新起的那条结算）", async () => {
    const hook = recorder();
    const journal = new SweepableJournalStore();
    const runId = "dwfrun-residency-resume";
    preloadRun(journal, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      runId,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({
      journal,
      registerResidencyBlockingWork: hook.register,
    });

    const resumed = harness.service.resume!(runId);
    expect(hook.works).toHaveLength(1);

    expect(await resumed).toMatchObject({ ok: true, runId });
    expect(hook.settled[0]).toBe(false);

    await settle(harness, runId);
    await hook.works[0];
    expect(hook.settled[0]).toBe(true);
    expect(hook.works).toHaveLength(1);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
  });
});

describe("dynamic workflow run service — submit", () => {
  it("返回 runId 并把 run 跑到 completed", async () => {
    const harness = makeHarness();

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("submit-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("submit-call"),
      trace: traceFor("submit-ok"),
    });

    expect(runId).toBeTruthy();
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    // The script's top-level return value is the run's artifact (Answer.text).
    expect(snapshot?.output).toBe("done");
  });

  it("runId 字符集安全：无 # @ /", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-charset"),
    });
    await settle(harness, runId);

    expect(runId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  // "Compile once": one ts.Program feeds the site table / schema synthesis / lowering. The three convenience entries each
  // build their own program; chaining them would typecheck three times — this assertion guards against switching the chain back to the convenience entries.
  it("一次 submit 只建一个 ts.Program", async () => {
    const harness = makeHarness();
    compiledScripts.length = 0;

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-compile-once"),
    });
    await settle(harness, runId);

    expect(compiledScripts.filter((script) => script === TYPED_SCRIPT)).toHaveLength(1);
  });

  // Engine-exclusive createRun: the submit path never pre-inserts a dwf_run row, or engine construction flips into the
  // resume branch and silently "recovers" from an empty journal.
  it("submit 不预插 dwf_run 行，run 由引擎创建", async () => {
    const journal = new InMemoryJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const getRun = vi.spyOn(journal, "getRun");
    const harness = makeHarness({ journal });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-create-run"),
    });
    await settle(harness, runId);

    // createRun exactly once, and inside engine construction — the getRun before it must return undefined
    // (that is exactly the engine's evidence for "new run, not resume").
    expect(createRun).toHaveBeenCalledTimes(1);
    const firstGetRunResult = getRun.mock.results[0];
    expect(firstGetRunResult?.value).toBeUndefined();
  });

  // Run metadata persisted: without these four fields, resume's script_hash check has nothing to compare.
  it("scriptText / scriptHash / parentSessionId / cwd 落库", async () => {
    const harness = makeHarness();
    const parentSessionId = createSessionId("meta-parent");

    const runId = await submitRun(harness, {
      cwd: "/tmp/dwf-meta",
      parentSessionId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-meta"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.scriptText).toBe(TYPED_SCRIPT);
    expect(record?.parentSessionId).toBe(parentSessionId);
    expect(record?.cwd).toBe("/tmp/dwf-meta");
    // scriptHash is computed by the caller (this service): sha256 hex over the author's original text, not the lowered function body.
    const { createHash } = await import("node:crypto");
    expect(record?.scriptHash).toBe(
      createHash("sha256").update(TYPED_SCRIPT, "utf8").digest("hex"),
    );
  });

  // Defensive: a dirty script must not reach submit (the handler calls only on ok); if it does, fail hard and create no run.
  it("脏脚本硬失败且不建 run", async () => {
    const journal = new InMemoryJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const harness = makeHarness({ journal });

    await expect(
      harness.service.submit({
        cwd: TEST_CWD,
        scriptText: BROKEN_SCRIPT,
        trace: traceFor("submit-broken"),
      }),
    ).rejects.toThrow(/does not typecheck/);

    // Not a single dwf_run row created: the dirty script is blocked at compile and the engine is never constructed.
    expect(createRun).not.toHaveBeenCalled();
    // The actor session never started either.
    expect(harness.actorRuntimeInputs).toEqual([]);
  });

  it("caps 只剩并发上界；双核机器的默认并发地板为 4", async () => {
    const harness = makeHarness({ availableParallelism: () => 2 });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-caps"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.caps).toEqual({ maxConcurrency: 4 });
  });
});

// ── Concurrent request ceiling (docs/dynamic-workflow/concurrency.md "Two bounds on a run") ─────────────
// `max_concurrency` is used as-is above or below the default concurrency, with no cap: absent means default concurrency.
// This group pins the whole chain "request → rounding → dwf_run.caps_max_concurrency → both read faces → run-started payload".
describe("dynamic workflow run service — 请求的并发上界", () => {
  /** 10 cores → default concurrency 8: above the floor 4 and below the hard cap 16. */
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  async function submitWithLimit(
    harness: Harness,
    name: string,
    maxConcurrency?: number,
  ): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      trace: traceFor(name),
    });
    await settle(harness, runId);
    return runId;
  }

  it("请求低于默认并发 → 原样落 dwf_run.caps_max_concurrency", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-3", 3);
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 3 });
  });

  it("请求高于默认并发 → 原样照用（没有上限：默认是起点不是天花板）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-99", 99);
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(99);
  });

  it("缺席 → 默认并发", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-absent");
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
  });

  it("0 / 负数 → 地板 1；非整数向下取整（绝不偷偷越过用户说的数）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const zero = await submitWithLimit(harness, "limit-zero", 0);
    expect(harness.journal.getRun(zero)?.caps.maxConcurrency).toBe(1);
    const negative = await submitWithLimit(harness, "limit-negative", -5);
    expect(harness.journal.getRun(negative)?.caps.maxConcurrency).toBe(1);
    const fractional = await submitWithLimit(harness, "limit-fractional", 3.7);
    expect(harness.journal.getRun(fractional)?.caps.maxConcurrency).toBe(3);
  });

  it("amend 把上界带到后继 run（前驱的值不被继承——三态归一在工具层）", async () => {
    // Hang the actor: the predecessor has no completed ask, so the precheck needs no message boundaries
    // (an assembly without transcript storage has no boundary bookkeeping anyway — same as the existing amend cases).
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 2,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-a"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(predecessor)?.caps.maxConcurrency).toBe(2);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 5,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-b"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(amended.runId)?.caps.maxConcurrency).toBe(5);
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // Same predecessor, no field this time: the successor runs at default concurrency (absent ≠ inherit the predecessor's 2).
    const inherited = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-c"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(inherited.runId)?.caps.maxConcurrency).toBe(
        DEFAULT_OF_TEN_CORES,
      );
    });
    expect(await harness.service.cancel(inherited.runId)).toBe(true);
    await settle(harness, inherited.runId);
  });

  it("defaultConcurrency() 与默认并发的唯一实现同值（必须与缺省落库的那个数对得上）", () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    expect(harness.service.defaultConcurrency!()).toBe(
      resolveWorkflowDefaultConcurrency(TEN_CORES),
    );
    expect(harness.service.defaultConcurrency!()).toBe(DEFAULT_OF_TEN_CORES);
  });

  it("快照只在不等于默认并发时带 maxConcurrency（高于、低于都带）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const limited = await submitWithLimit(harness, "snapshot-limited", 2);
    expect(await harness.service.getTask(limited)).toMatchObject({ maxConcurrency: 2 });
    const raised = await submitWithLimit(harness, "snapshot-raised", 20);
    expect(await harness.service.getTask(raised)).toMatchObject({ maxConcurrency: 20 });

    // A run at the default has nothing to say: the field is entirely absent, not reported as a number equal to the default.
    const unlimited = await submitWithLimit(harness, "snapshot-unlimited");
    const snapshot = await harness.service.getTask(unlimited);
    expect("maxConcurrency" in snapshot!).toBe(false);
    const explicitDefault = await submitWithLimit(
      harness,
      "snapshot-default",
      DEFAULT_OF_TEN_CORES,
    );
    expect("maxConcurrency" in (await harness.service.getTask(explicitDefault))!).toBe(false);
  });

  // The gap (submit already returned, the dwf_run row not yet written) is when AmendWorkflow's
  // resolveInput is most likely to read the snapshot — amending a just-started run. The registry
  // copy must give the same answer as the row.
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({
        availableParallelism: TEN_CORES,
        hangActors: true,
        journal,
      });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        maxConcurrency: 2,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("limit-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        maxConcurrency: 2,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          maxConcurrency: 2,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("getRunDetail 带 maxConcurrency，列表行不带（很少设置的字段不该把每一行加宽）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ availableParallelism: TEN_CORES, journal });
      const limited = await submitRun(harness, {
        cwd: projectCwd,
        maxConcurrency: 2,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-limited"),
      });
      await settle(harness, limited);
      const unlimited = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-unlimited"),
      });
      await settle(harness, unlimited);

      const introspection = introspectionOf(harness);
      expect(await introspection.getRunDetail(limited)).toMatchObject({ maxConcurrency: 2 });
      const plain = await introspection.getRunDetail(unlimited);
      expect("maxConcurrency" in plain!).toBe(false);

      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("maxConcurrency" in row).toBe(false);
    });
  });

  // A cross-slice contract: `concurrencyCeiling` on the `run-started` payload is the other half the
  // shared reducer uses to decide "does this run have its own ceiling" (the other half being the engine's own caps.maxConcurrency).
  it("run-started 载荷带 concurrencyCeiling，与引擎的 caps 并列", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "payload-ceiling", 2);

    const started = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-started",
    );
    expect(started?.payload).toMatchObject({
      caps: { maxConcurrency: 2 },
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });
  });
});

// ── Retuning a live run's ceiling in place (docs/dynamic-workflow/concurrency.md "Retuning a live run") ──
// An amendment that changes only `max_concurrency` mints no successor: same runId, no supersede, no in-flight ask lost.
// This group pins every observable consequence on the port side — the row, the registry copy, events (including the
// host-derived default concurrency), both rejections, clamping, and "resume starts from the new ceiling". The
// engine-internal half (live caps reads, pumpAll, no-op) is covered by dynamic-workflow's engine-retune-concurrency tests.
describe("dynamic workflow run service — retuneConcurrency", () => {
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  /** Start a hung run (actor never returns ⇒ run stays in flight) and wait for the engine to write the dwf_run row. */
  async function liveRun(harness: Harness, name: string, maxConcurrency?: number): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toBeDefined();
    });
    return runId;
  }

  function retune(harness: Harness, runId: string, maxConcurrency: number | null) {
    return harness.service.retuneConcurrency!({ maxConcurrency, runId });
  }

  async function stop(harness: Harness, runId: string): Promise<void> {
    await harness.service.cancel(runId);
    await settle(harness, runId);
  }

  it("在飞 run：行、注册表副本与事件三处同时挪动，同一个 runId、没有后继", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-ok", 4);

    expect(await retune(harness, runId, 2)).toEqual({
      ok: true,
      maxConcurrency: 2,
      previous: 4,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    // resume reuses the caps from the row, so not persisting equals changing nothing.
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 2 });
    // Registry copy: the snapshot reads it first; left unmoved it keeps reporting the submit-time number
    // after retune, and AmendWorkflow's resolveInput reads exactly that snapshot to decide "what to carry over".
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });

    const changed = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({
      runId,
      caps: { maxConcurrency: 2 },
      previous: { maxConcurrency: 4 },
    // Host-derived field: the read side uses it to decide whether the new ceiling gets written or cleared — the same seam as `run-started`.
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });
    await stop(harness, runId);
  });

  it("同一个值 ⇒ unchanged，点名此刻生效的上界；什么都不写、什么都不发", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-unchanged", 3);

    expect(await retune(harness, runId, 3)).toEqual({ ok: false, reason: "unchanged", current: 3 });
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 3 });
    expect(
      harness.runEvents.filter((event) => event.eventType === "run-caps-changed"),
    ).toHaveLength(0);
    await stop(harness, runId);
  });

  it("高于默认并发照用、没有上限；等于默认时读面把字段整个撤掉", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-clamp", 2);

    expect(await retune(harness, runId, 99)).toEqual({
      ok: true,
      maxConcurrency: 99,
      previous: 2,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 99 });
    expect(await retune(harness, runId, DEFAULT_OF_TEN_CORES)).toMatchObject({ ok: true });
    const snapshot = await harness.service.getTask(runId);
    expect("maxConcurrency" in snapshot!).toBe(false);
    // Same rule as the floor: 0 and negatives both clamp to 1.
    expect(await retune(harness, runId, 0)).toMatchObject({ ok: true, maxConcurrency: 1 });
    await stop(harness, runId);
  });

  it("null = 默认并发 = 解除本 run 自己的界", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-null", 2);

    expect(await retune(harness, runId, null)).toEqual({
      ok: true,
      maxConcurrency: DEFAULT_OF_TEN_CORES,
      previous: 2,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    // Already at the default; asking to "lift" again is the same value.
    expect(await retune(harness, runId, null)).toMatchObject({ ok: false, reason: "unchanged" });
    await stop(harness, runId);
  });

  // The governor side (docs/dynamic-workflow/concurrency.md "The governor" / "The control path"):
  // launch registers this run's ceiling with the governor (raising the growth cap of keys it has used),
  // retune overrides via the control path, and launch's settlement clears it — all three swap values in
  // the same instant as the scheduler and seat gate.
  it("launch 登记上界、retune 覆盖、结算清掉：治理器上的增长上限跟着 run 走", async () => {
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    const calls: string[] = [];
    const concurrency: WorkflowConcurrencyPort = {
      tryAdmit: (runId, key) => governor.tryAdmit(runId, key),
      admit: (runId, key, signal) => governor.admit(runId, key, signal),
      subscribe: (runId, listener) => governor.subscribe(runId, listener),
      setRunBound: (runId, bound) => {
        calls.push(`set:${runId}:${bound}`);
        governor.setRunBound(runId, bound);
      },
      clearRunBound: (runId) => {
        calls.push(`clear:${runId}`);
        governor.clearRunBound(runId);
      },
    };
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true, concurrency });
    const runId = await liveRun(harness, "retune-governor", 30);
    await vi.waitFor(() => {
      expect(calls).toContain(`set:${runId}:30`);
    });
    expect(await retune(harness, runId, 40)).toMatchObject({ ok: true, maxConcurrency: 40 });
    expect(calls).toContain(`set:${runId}:40`);
    await stop(harness, runId);
    await vi.waitFor(() => {
      expect(calls.at(-1)).toBe(`clear:${runId}`);
    });
  });

  it("结算之后与未知 run 都是 not_live（调用方回落到一次真正的修订）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-settled", 4);
    await stop(harness, runId);

    expect(await retune(harness, runId, 2)).toEqual({ ok: false, reason: "not_live" });
    expect(await retune(harness, "dwfrun-nobody", 2)).toEqual({ ok: false, reason: "not_live" });
    // Rejection has zero side effects: the row is still the one from the moment of the stop.
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("resume 从 retune 之后的上界起跑（行是 caps 的权威，条目抄的也是它）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-resume", 4);
    expect(await retune(harness, runId, 2)).toMatchObject({ ok: true, maxConcurrency: 2 });
    await stop(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 2 });
    });
    // The new generation's registry entry copies the number from the row, so `previous` reflects the ceiling after retune.
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });
    expect(await retune(harness, runId, 5)).toMatchObject({ ok: true, previous: 2 });
    await stop(harness, runId);
  });

  // The **end-to-end** half of the same contract: the live side is minted by launch's emit hook
  // (toProgressPayload's `run-caps-changed` branch), the cold side by replayRunProgress. The two must be
  // byte-identical — the live path assembles default concurrency only on `run-started` while the cold path
  // assembles it on every event; that difference is exactly what this case guards against.
  it("live 与冷回放为同一条 run-caps-changed 铸出逐字节相同的载荷", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({
      availableParallelism: TEN_CORES,
      hangActors: true,
      journal,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 4,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("retune-live-vs-cold"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toBeDefined();
    });
    expect(await retune(harness, runId, 2)).toMatchObject({ ok: true });
    await stop(harness, runId);

    const live = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    // Cold side: same journal, new service (this process holds no entry for the run, so it gets replayed).
    const cold = makeHarness({ availableParallelism: TEN_CORES, journal });
    const replayed = await cold.service.replayProgressForSession!({ excludeRunIds: new Set() });
    const coldEvent = replayed.find(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );

    expect(live).toBeDefined();
    expect(coldEvent).toEqual(live);
  });
});

// ── End to end: real AmendWorkflow tool → real run service → real engine → journal / events ─────────────
// docs/dynamic-workflow/launch.md "Changing only the parallelism of a live run". The group above asserts
// directly against the service, and the core-side cases stub the port — nothing between the two seams proves
// they actually line up. This group chains the tool executor, resolveInput routing, the handler, the port,
// the engine, and the journal into one line.
//
// **What is real**: the tool registry and executor, AmendWorkflow's resolveInput / permission step / handler,
// `createDynamicWorkflowRunService`, the engine and scheduler, the driver, journal rows and event stream, progress payloads.
// **What is stubbed**: the actors' model adapter (`hangActors`: generateText never resolves, so the three asks
// park stably in flight), and the concurrency probe (fixed 10 cores → default concurrency 8).
//
// **Parking is not proven here**: making a subagent actually emit the "next turn step" needs a fake model with an
// external dial, which this harness's scripted adapter cannot provide. The seat-gate half is proven by
// workflow-driver-seat-gate.test.ts with a real governor + real driver (4→1 lower parks, FIFO admission, tool side
// does not park, cancel frees no seat); this group proves "one tool invocation really moved the ceiling onto the
// engine and the journal, without touching a single in-flight ask".
describe("dynamic workflow run service — AmendWorkflow 就地 retune（端到端）", () => {
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  /** Three subagents in flight at once: lowering the ceiling is only meaningful with "the excess ones" present. */
  const THREE_PARALLEL_SCRIPT = [
    "interface Answer { text: string }",
    'const one = agent("one");',
    'const two = agent("two");',
    'const three = agent("three");',
    "const [a, b, c] = await Promise.all([",
    '  one.ask<Answer>("first"),',
    '  two.ask<Answer>("second"),',
    '  three.ask<Answer>("third"),',
    "]);",
    "return `${a.text}|${b.text}|${c.text}`;",
  ].join("\n");

  interface AmendOutcome {
    success: boolean;
    message: string;
    output: { response: string; diagnostics?: unknown[]; retuned?: Record<string, unknown> };
  }

  it("只带 max_concurrency 的一次调用：同一个 run 被就地改低，在飞 ask 一个不停", async () => {
    const journal = new SweepableJournalStore();
    const sessionId = createSessionId("retune-e2e");
    const harness = makeHarness({
      availableParallelism: TEN_CORES,
      hangActors: true,
      journal,
      parentSessionId: sessionId,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: sessionId,
      scriptText: THREE_PARALLEL_SCRIPT,
      trace: traceFor("retune-e2e"),
    });
    // All three asks are dispatched and stuck in model requests; the run started at default concurrency (no max_concurrency at submit).
    await vi.waitFor(() => {
      expect(
        journal
          .listNodes(runId, { kinds: "all", withResult: true })
          .filter((node) => node.status === "running"),
      ).toHaveLength(3);
    });
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    const runsBefore = journal.listRunsByParentSession(sessionId, 50).length;

    // ——— Real tool executor ———
    const registry = createToolRegistry();
    const amendEntry = builtInTools.find((entry) => entry.metadata.name === "AmendWorkflow");
    expect(amendEntry).toBeDefined();
    registry.register(amendEntry!);
    const turnId = createTurnId("retune-e2e");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const permissionAsks: unknown[] = [];
    const executor = createToolExecutor({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: harness.service,
      mode: "build",
      permissionBroker: {
        async requestPermission(request) {
          permissionAsks.push(request);
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: TEST_CWD,
    });
    const amend = async (maxConcurrency: number | null): Promise<AmendOutcome> => {
      const result = await executor.execute(
        {
          id: createToolCallId(`retune-e2e-${String(maxConcurrency)}`),
          input: { max_concurrency: maxConcurrency, run_id: runId },
          name: "AmendWorkflow",
        },
        { traceContext },
      );
      return {
        success: result.success,
        message: String(result.error?.message ?? ""),
        output: result.output as AmendOutcome["output"],
      };
    };

    // ——— 1. Lower to 1 ———
    const lowered = await amend(1);
    expect(lowered.success).toBe(true);
    expect(lowered.output.response).toBe(
      `Applied to the running run ${runId}; at most 1 subagent runs at once. ` +
        `Run ${runId} keeps running under it: nothing was stopped and no new run was started.`,
    );
    expect(lowered.output.retuned).toEqual({
      runId,
      maxConcurrency: 1,
      previous: DEFAULT_OF_TEN_CORES,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    // Not an amendment: no background task, no compile artifacts, no diagnostics.
    expect(lowered.output).not.toHaveProperty("backgroundTaskId");
    expect(lowered.output).not.toHaveProperty("status");
    expect(lowered.output).not.toHaveProperty("causalityGraph");
    expect(lowered.output.diagnostics).toEqual([]);
    // This session's own in-flight run: no confirmation dialog (the ownership rule in docs/dynamic-workflow/launch.md).
    expect(permissionAsks).toEqual([]);

    // Same run, no successor, nobody superseded.
    expect(journal.listRunsByParentSession(sessionId, 50)).toHaveLength(runsBefore);
    const row = journal.getRun(runId);
    expect(row?.status).toBe("running");
    expect(row?.supersededBy).toBeUndefined();
    expect(row?.caps.maxConcurrency).toBe(1);
    expect(harness.runEvents.filter((event) => event.eventType === "run-settled")).toEqual([]);

    // Exactly one run-caps-changed, carrying the default concurrency the host assembled.
    const changed = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toEqual({
      runId,
      caps: { maxConcurrency: 1 },
      previous: { maxConcurrency: DEFAULT_OF_TEN_CORES },
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });

    // The snapshot reports the new value immediately (it is exactly what AmendWorkflow's resolveInput reads to
    // decide "what to carry over"). The detail face and `GetWorkflowRun` read the same `runConcurrencyField`,
    // sourced from the caps row asserted below; that read face needs a journal with the introspection query,
    // covered by this file's "getRunDetail with maxConcurrency" group.
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 1 });

    // None of the three in-flight asks was stopped: the row is still running and there is not a single node-settled.
    expect(
      journal
        .listNodes(runId, { kinds: "all", withResult: true })
        .filter((node) => node.status === "running"),
    ).toHaveLength(3);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "node-settled",
      ),
    ).toEqual([]);

    // ——— 2. The same value again ———
    const again = await amend(1);
    expect(again.success).toBe(false);
    expect(again.message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(again.message).toContain(runId);
    // Rejection has zero side effects: the row did not move and there is no second event.
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(1);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "run-caps-changed",
      ),
    ).toHaveLength(1);

    // ——— 3. null back to default concurrency ———
    const raised = await amend(null);
    expect(raised.success).toBe(true);
    expect(raised.output.response).toBe(
      `Applied to the running run ${runId}; at most ${DEFAULT_OF_TEN_CORES} subagents run at once ` +
        `(the default). ` +
        `Run ${runId} keeps running under it: nothing was stopped and no new run was started.`,
    );
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    // Back to default concurrency ⇒ the read face drops the field entirely ("absent when none").
    const snapshot = await harness.service.getTask(runId);
    expect("maxConcurrency" in snapshot!).toBe(false);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "run-caps-changed",
      ),
    ).toHaveLength(2);

    // After three invocations the run is still healthy and still owned by this service: it stops normally, settling as recoverable stopped(user).
    expect(
      journal
        .listNodes(runId, { kinds: "all", withResult: true })
        .filter((node) => node.status === "running"),
    ).toHaveLength(3);
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect(journal.getRun(runId)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(journal.listRunsByParentSession(sessionId, 50)).toHaveLength(runsBefore);
  });
});

// ── This run's subagent model (docs/dynamic-workflow/launch.md) ─────────────────────────────
// `subagent_model` describes only which model the **subagents** run on; the main agent stays on the
// session model. This group pins the whole chain "request → normalize to a canonical string → recorded
// into the journal event run-launched → both read faces → run-started payload → actor runtime factory".
// Absent means subagents run on the session model, and the key is genuinely absent at every spot.
//
// The landing spot is the **event, not a column** (user decision: no migration): it lives in `run-launched`
// alongside the origin anchor and phase table, written once in the generation that creates the run; the host reads it back from the event header.
describe("dynamic workflow run service — 本 run 的子代理模型", () => {
  /** Selection with a thought level: `$level` is part of the selection and must travel the whole chain inside the canonical string. */
  const FLASH: ModelSelection = {
    providerId: "zhipu",
    modelId: "glm-5.3-flash",
    options: { reasoningLevel: "high" },
  };
  const FLASH_CANONICAL = "zhipu/glm-5.3-flash$high";
  /** Selection without a level: the canonical string therefore has only two segments. */
  const HAIKU: ModelSelection = { providerId: "anthropic", modelId: "haiku" };

  /** This run's `run-launched` event: the subagent model lives here (there is no such column on dwf_run). */
  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  const subagentModelOf = (harness: Harness, runId: string): string | undefined => {
    const launched = launchedOf(harness, runId);
    return launched?.type === "run-launched" ? launched.subagentModel : undefined;
  };

  it("submit 把规范 picker 串记进 run-launched（含 reasoning 档位），行上没有这条事实", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-submit"),
    });
    await settle(harness, runId);

    expect(subagentModelOf(harness, runId)).toBe(FLASH_CANONICAL);
    // Zero SQL: the fact is not on the record row; the read side always goes through events (user decision: no migration).
    expect("subagentModel" in harness.journal.getRun(runId)!).toBe(false);
  });

  it("没有档位的选择记成两段；不设即整个键缺席（不是 undefined）", async () => {
    const harness = makeHarness();
    const levelled = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: HAIKU,
      trace: traceFor("subagent-model-two-part"),
    });
    await settle(harness, levelled);
    expect(subagentModelOf(harness, levelled)).toBe("anthropic/haiku");

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-absent"),
    });
    await settle(harness, plain);
    // Key absent rather than `undefined`: the read side judges "did this run set a subagent model" by presence.
    expect("subagentModel" in launchedOf(harness, plain)!).toBe(false);
  });

  it("快照与详情给出同一个规范串；不设时两条读面都不带这个键", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const chosen = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        subagentModel: FLASH,
        trace: traceFor("subagent-model-read-set"),
      });
      await settle(harness, chosen);
      const plain = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("subagent-model-read-absent"),
      });
      await settle(harness, plain);

      const introspection = introspectionOf(harness);
      expect(await harness.service.getTask(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await introspection.getRunDetail(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });

      const snapshot = await harness.service.getTask(plain);
      expect("subagentModel" in snapshot!).toBe(false);
      const detail = await introspection.getRunDetail(plain);
      expect("subagentModel" in detail!).toBe(false);

      // Not on list rows: same rule as the concurrency ceiling — a rarely set field must not widen every row of the enumeration face.
      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("subagentModel" in row).toBe(false);

      // Restart (new service, empty registry, same journal): the in-memory copy is gone and both read faces
      // can only read back from the `run-launched` event — this assertion is the evidence that cold reads work with zero SQL.
      const cold = makeHarness({ journal });
      const coldIntrospection = introspectionOf(cold);
      expect(await cold.service.getTask(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await coldIntrospection.getRunDetail(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect("subagentModel" in (await cold.service.getTask(plain))!).toBe(false);
      expect("subagentModel" in (await coldIntrospection.getRunDetail(plain))!).toBe(false);
    });
  });

  // The gap (submit already returned, the dwf_run row not yet written): AmendWorkflow's resolveInput reads the
  // snapshot to decide "what to carry over", and amending a just-started run lands exactly here. The registry
  // copy must give the same answer as after the row lands.
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        subagentModel: FLASH,
        trace: traceFor("subagent-model-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          subagentModel: FLASH_CANONICAL,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("amend 用请求里的值，绝不继承前驱的（三态归一在工具层）", async () => {
    const harness = makeHarness({ hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-amend-a"),
    });
    await vi.waitFor(() => {
      expect(subagentModelOf(harness, predecessor)).toBe(FLASH_CANONICAL);
    });

    // Switch the model: the successor lands the new value.
    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      subagentModel: HAIKU,
      trace: traceFor("subagent-model-amend-b"),
    });
    await vi.waitFor(() => {
      expect(subagentModelOf(harness, amended.runId)).toBe("anthropic/haiku");
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // Same predecessor, no field this time: the successor returns to the session model (absent ≠ inherit the
    // predecessor's FLASH). If the port inherited here, the tool-face `null` ("back to the session model")
    // would never reach persistence.
    const cleared = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, cleared.runId)).toBeDefined();
    });
    expect("subagentModel" in launchedOf(harness, cleared.runId)!).toBe(false);
    expect(await harness.service.cancel(cleared.runId)).toBe(true);
    await settle(harness, cleared.runId);
  });

  it("run-started 载荷带 subagentModel，与 concurrencyCeiling 并列；不设即不出", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-payload"),
    });
    await settle(harness, runId);

    const started = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-started",
    );
    expect(started?.payload).toMatchObject({ subagentModel: FLASH_CANONICAL });

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-payload-absent"),
    });
    await settle(harness, plain);
    const plainStarted = harness.runEvents.find(
      (event) => event.runId === plain && event.eventType === "run-started",
    );
    expect("subagentModel" in plainStarted!.payload).toBe(false);
  });

  it("actor runtime 工厂拿到解析回来的整条选择（含档位），不设时缺席", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-factory"),
    });
    await settle(harness, runId);

    // The factory receives a structured selection, not the string: the pin records only the two identity segments; the level can only flow in from here.
    expect(harness.actorRuntimeInputs.at(-1)?.runSubagentModel).toEqual(FLASH);

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-factory-absent"),
    });
    await settle(harness, plain);
    expect("runSubagentModel" in harness.actorRuntimeInputs.at(-1)!).toBe(false);
  });

  it("resume 从 run-launched 事件读回选择，交给工厂并抄进注册表条目", async () => {
    // resume reuses the recorded one, the same discipline as caps / args: a run's identity includes which model it runs on.
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    // Factory input of the resumed generation: the whole selection comes back (level intact), even though the resume entry has no such parameter.
    expect(harness.actorRuntimeInputs.at(-1)?.runSubagentModel).toEqual(FLASH);

    // The resumed generation's entry also carries this selection, leaving one read-face rule: read the entry
    // when present; scan the event header only for cold rows. The spy is the evidence — the snapshot answers
    // the model without issuing a single listEvents.
    const listEvents = vi.spyOn(harness.journal, "listEvents");
    expect(await harness.service.getTask(runId)).toMatchObject({
      subagentModel: FLASH_CANONICAL,
    });
    expect(listEvents).not.toHaveBeenCalled();
    listEvents.mockRestore();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });

  it("amend 带 subagentModel：run 选择压过前驱承袭的 pin，新 run 的 resolved_model 记的是新选择", async () => {
    // Regression case (2026-09-17 testfield, dwf-assets/workflow-subagent-model-precedence-brief.md):
    // the predecessor's subagents run on the pin; AmendWorkflow with `subagent_model` switches the model,
    // run-launched records the new selection, the confirmation dialog says "Subagents run on Z", yet the
    // driver still builds sessions on the pin — every resumed subagent with live work runs on the wrong
    // model. Omitted means inherit, explicit means replace: the pin only guards the implicit default when
    // there is no run selection.
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-model-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // Predecessor: both worker asks are live, sessions and boundaries actually persisted — at amend time the
      // second ask diverges while the first, as a completed prefix, seeds the import table with transcript
      // seeds; the pin is inherited along with the seeds (an actor diverging at seq 0 has no prefix and no seeds).
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("subagent-model-over-pin-a"),
      });
      await settle(before, runA);

      // The predecessor worker runs on the session model. Rewrite its record to a sentinel so that
      // pin ≠ session model ≠ this selection — the three sources pairwise differ, making "who wins" assertable.
      const workerRow = journal.getActor(runA, "actor#1", 1)!;
      expect(workerRow.resolvedModel).toBe("test/default-runtime-model");
      journal.putActor({ ...workerRow, resolvedModel: "pinned/from-predecessor" });

      // Amend: change only the second ask, and pass a new subagent model.
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const amended = await amendRun(after, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        subagentModel: HAIKU,
        trace: traceFor("subagent-model-over-pin-b"),
      });
      await settle(after, amended.runId);
      expect((await after.service.getTask(amended.runId))?.output).toBe("one|revised|0");

      // The worker built exactly one session at the diverging ask, and the factory receives both the inherited
      // pin and this run's selection — with both present, the assertion is about precedence, not one side's absence.
      expect(after.actorRuntimeInputs).toHaveLength(1);
      expect(after.actorRuntimeInputs[0]).toMatchObject({
        pinnedModel: "pinned/from-predecessor",
        runSubagentModel: HAIKU,
      });
      // Regression point: the new run's own record carries the run selection (before the fix this read the pin).
      expect(journal.getActor(amended.runId, "actor#1", 1)?.resolvedModel).toBe("anthropic/haiku");
      // The predecessor's record is untouched by a byte: lineage keeps the "model was switched" history — nothing is silent.
      expect(journal.getActor(runA, "actor#1", 1)?.resolvedModel).toBe("pinned/from-predecessor");
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

// ── Script-named models (docs/dynamic-workflow/launch.md "Models the script names") ─────────────
// persona's `model` name → binding table on run-launched → table lookup at session creation, overriding
// the run's subagent model → dwf_actor.resolved_model records the one actually used. resume reads the
// same table back from the same event.
describe("dynamic workflow run service — 脚本点名的模型", () => {
  const LIGHT: ModelSelection = { providerId: "zhipu", modelId: "GLM-5.3-Flash" };
  const STRONG: ModelSelection = {
    providerId: "zhipu",
    modelId: "GLM-5.3",
    options: { reasoningLevel: "high" },
  };
  const RUN_DEFAULT: ModelSelection = { providerId: "anthropic", modelId: "haiku" };
  const ROUTED_SCRIPT = [
    "interface Answer { text: string }",
    'const MODELS = { light: model("GLM-5.3-Flash"), strong: model("GLM-5.3$high") };',
    'const judge = await agent("评审员", { model: MODELS.light }).ask<Answer>("judge");',
    'const writer = await agent("写手", { model: MODELS.strong }).ask<Answer>("write");',
    'const plain = await agent("旁观者").ask<Answer>("watch");',
    'return [judge.text, writer.text, plain.text].join(",");',
  ].join("\n");

  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  it("每个子代理跑在自己 persona 点名的模型上，压过 run 的子代理模型；没点名的照旧跑 run 的", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      subagentModel: RUN_DEFAULT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-routed"),
    });
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.runStatus).toBe("completed");

    const launched = launchedOf(harness, runId);
    expect(launched).toMatchObject({
      modelBindings: {
        "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash",
        "GLM-5.3$high": "zhipu/GLM-5.3$high",
      },
    });
    // The factory receives the whole selection (level included); subagents without a named model have no such key.
    const byActor = new Map(
      harness.actorRuntimeInputs.map((input) => [refToString(input.actor), input]),
    );
    expect(byActor.get("actor#1@1")?.actorModel).toEqual(LIGHT);
    expect(byActor.get("actor#2@1")?.actorModel).toEqual(STRONG);
    expect("actorModel" in byActor.get("actor#3@1")!).toBe(false);
    // What lands in the store is the one the runtime actually got: the persona's model overrides the run's subagent model.
    expect(harness.journal.getActor(runId, "actor#1", 1)?.resolvedModel).toBe(
      "zhipu/GLM-5.3-Flash",
    );
    expect(harness.journal.getActor(runId, "actor#2", 1)?.resolvedModel).toBe("zhipu/GLM-5.3");
    expect(harness.journal.getActor(runId, "actor#3", 1)?.resolvedModel).toBe("anthropic/haiku");
    // What the persona records is the name the script wrote verbatim (ModelRef was already reduced to a name in lowering).
    expect(harness.journal.getActor(runId, "actor#2", 1)?.persona).toMatchObject({
      model: "GLM-5.3$high",
    });
  });

  it("actor-created 载荷派生出子代理的规范模型串；没点名模型的不带", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-payload"),
    });
    await settle(harness, runId);
    const created = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "actor-created",
    );
    expect(created.map((event) => event.payload.model)).toEqual([
      "zhipu/GLM-5.3-Flash",
      "zhipu/GLM-5.3$high",
      undefined,
    ]);
    expect("model" in created[2]!.payload).toBe(false);
    // Dispatch repeats the birth fact: the engine carries the persona's name (actorPersonaModel), the host
    // derives the canonical string (actorModel), and the read face rebuilds the recalled subagent together
    // with its model from it.
    const dispatched = harness.runEvents.filter(
      (event) =>
        event.runId === runId &&
        event.eventType === "node-dispatched" &&
        event.payload.kind === "ask",
    );
    expect(
      dispatched.map((event) => [event.payload.actorPersonaModel, event.payload.actorModel]),
    ).toEqual([
      ["GLM-5.3-Flash", "zhipu/GLM-5.3-Flash"],
      ["GLM-5.3$high", "zhipu/GLM-5.3$high"],
      [undefined, undefined],
    ]);
  });

  it("绑定表里没有的名字（只有绕过 9010 的断言做得到）让那一问以 DriverError 失败，不退回别的模型", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: [
        "interface Answer { text: string }",
        'const name = "GLM-9" as unknown as ModelRef;',
        'const a = await agent("评审员", { model: name }).ask<Answer>("judge");',
        "return a.text;",
      ].join("\n"),
      subagentModel: RUN_DEFAULT,
      trace: traceFor("script-models-unbound"),
    });
    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.runStatus).toBe("errored");
    expect(JSON.stringify(snapshot)).toContain('\\"GLM-9\\"');
    expect(harness.actorRuntimeInputs).toHaveLength(0);
  });

  const TABLE = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash", "GLM-5.3$high": "zhipu/GLM-5.3$high" };

  it("快照与详情带出绑定表：热路径读条目，冷行扫事件头", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: ROUTED_SCRIPT,
        modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
        trace: traceFor("script-models-read"),
      });
      await settle(harness, runId);
      expect(await harness.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        modelBindings: TABLE,
      });
      // Cold row (another process, no entry): the same table read back from run-launched.
      const cold = makeHarness({ journal });
      expect(await cold.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
      expect(await introspectionOf(cold).getRunDetail(runId)).toMatchObject({
        modelBindings: TABLE,
      });
    });
  });

  it("resume 从 run-launched 读回同一张表交给工厂，并抄进注册表条目", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    expect(harness.actorRuntimeInputs.at(-1)?.actorModel).toEqual(LIGHT);
    expect(await harness.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });
});

// ── This run's subagent permission mode (docs/dynamic-workflow/launch.md "Permissions inside a run") ──
// The generation that creates the run records the originating session's permission mode into
// `run-launched.subagentPermissionMode`; resume reads it back from the same event. However the session
// switches modes afterwards, this run does not change. plan is never carried into a run.
describe("dynamic workflow run service — 本 run 子代理的权限模式", () => {
  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  it("发起会话的模式原样记下并交给 actor 工厂；旧 plan 值记为 build", async () => {
    let mode: CollaborationMode = "guarded";
    const harness = makeHarness({ permissionMode: () => mode });
    const cases: ReadonlyArray<readonly [CollaborationMode, string]> = [
      ["guarded", "guarded"],
      ["build", "build"],
      ["edit", "edit"],
      ["yolo", "yolo"],
      ["auto", "auto"],
      ["plan", "build"],
    ];
    for (const [sessionMode, recorded] of cases) {
      mode = sessionMode;
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor(`permission-mode-${sessionMode}`),
      });
      await settle(harness, runId);
      expect(launchedOf(harness, runId)).toMatchObject({ subagentPermissionMode: recorded });
      expect(harness.actorRuntimeInputs.at(-1)?.subagentPermissionMode).toBe(recorded);
      // Zero SQL: the fact is not on the record row.
      expect("subagentPermissionMode" in harness.journal.getRun(runId)!).toBe(false);
    }
  });

  it("没接模式读取的宿主（CLI、测试装配）照旧 YOLO：键缺席", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-unwired"),
    });
    await settle(harness, runId);
    expect("subagentPermissionMode" in launchedOf(harness, runId)!).toBe(false);
    expect("subagentPermissionMode" in harness.actorRuntimeInputs.at(-1)!).toBe(false);
  });

  it("resume 以 run-launched 为准：会话已换到 yolo，续跑的子代理仍是 guarded", async () => {
    let mode: CollaborationMode = "guarded";
    const harness = makeHarness({ hangActors: true, permissionMode: () => mode });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    mode = "yolo";
    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    expect(harness.actorRuntimeInputs.at(-1)?.subagentPermissionMode).toBe("guarded");
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });

  it("amend 是新 run：取修订那一刻的会话模式，不继承前驱的", async () => {
    let mode: CollaborationMode = "yolo";
    const harness = makeHarness({ hangActors: true, permissionMode: () => mode });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-a"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, predecessor)).toBeDefined();
    });
    expect(launchedOf(harness, predecessor)).toMatchObject({ subagentPermissionMode: "yolo" });

    mode = "guarded";
    const guarded = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-b"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, guarded.runId)).toMatchObject({
        subagentPermissionMode: "guarded",
      });
    });

    mode = "build";
    const relaxed = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: guarded.runId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, relaxed.runId)).toBeDefined();
    });
    expect(launchedOf(harness, relaxed.runId)).toMatchObject({ subagentPermissionMode: "build" });
    expect(await harness.service.cancel(relaxed.runId)).toBe(true);
    await settle(harness, relaxed.runId);
  });
});

// ── This run's script file (Provenance in docs/dynamic-workflow/launch.md "Script files") ───────
// `scriptPath` records "which file this run's script came from", as an absolute path. Same rules as the
// subagent model point by point: recorded once with `run-launched`, not read by the engine, zero SQL,
// read back by both read faces (entry when present, event header for cold rows).
// The only difference: it has **no third state** — an amendment always records the new script's file and
// never inherits the predecessor's; the predecessor's path points at the old script, and inheriting it
// would send the model to edit a file that is no longer running.
describe("dynamic workflow run service — 本 run 的脚本文件", () => {
  const DRAFT = "/repo/.zcode/workflow-drafts/audit.dwf.ts";
  const REVISED = "/repo/.zcode/workflow-drafts/audit-2.dwf.ts";

  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  const scriptPathOf = (harness: Harness, runId: string): string | undefined => {
    const launched = launchedOf(harness, runId);
    return launched?.type === "run-launched" ? launched.scriptPath : undefined;
  };

  it("submit 把绝对路径记进 run-launched，行上没有这条事实；不给即整个键缺席", async () => {
    const harness = makeHarness();
    const withFile = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-submit"),
    });
    await settle(harness, withFile);
    expect(scriptPathOf(harness, withFile)).toBe(DRAFT);
    // Zero SQL: the fact is not on the record row (user decision: no migration); the read side always goes through events.
    expect("scriptPath" in harness.journal.getRun(withFile)!).toBe(false);

    const without = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("script-path-submit-absent"),
    });
    await settle(harness, without);
    // Key absent rather than `undefined`: the model face decides which next-step sentence to say by presence.
    expect("scriptPath" in launchedOf(harness, without)!).toBe(false);
  });

  it("快照与详情给出同一个绝对路径；不给时两条读面都不带这个键（冷重启后照样）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const withFile = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        scriptPath: DRAFT,
        trace: traceFor("script-path-read-set"),
      });
      await settle(harness, withFile);
      const without = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("script-path-read-absent"),
      });
      await settle(harness, without);

      const introspection = introspectionOf(harness);
      expect(await harness.service.getTask(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect(await introspection.getRunDetail(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect("scriptPath" in (await harness.service.getTask(without))!).toBe(false);
      expect("scriptPath" in (await introspection.getRunDetail(without))!).toBe(false);

      // Not on list rows: same rule as the subagent model and concurrency ceiling — a field only
      // AmendWorkflow uses must not widen every row of the enumeration face.
      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("scriptPath" in row).toBe(false);

      // Restart (new service, empty registry, same journal): the in-memory copy is gone and both read
      // faces can only read back from the `run-launched` event — evidence that cold reads work with zero SQL.
      const cold = makeHarness({ journal });
      const coldIntrospection = introspectionOf(cold);
      expect(await cold.service.getTask(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect(await coldIntrospection.getRunDetail(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect("scriptPath" in (await cold.service.getTask(without))!).toBe(false);
      expect("scriptPath" in (await coldIntrospection.getRunDetail(without))!).toBe(false);
    });
  });

  // The gap (submit already returned, the dwf_run row not yet written): same argument as the subagent
  // model — the registry copy must give the same answer as after the row lands.
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        scriptPath: DRAFT,
        trace: traceFor("script-path-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({ scriptPath: DRAFT });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        scriptPath: DRAFT,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          scriptPath: DRAFT,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("amend 用请求里的路径，绝不继承前驱的（不给即缺席，不是沿用）", async () => {
    const harness = makeHarness({ hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-amend-a"),
    });
    await vi.waitFor(() => {
      expect(scriptPathOf(harness, predecessor)).toBe(DRAFT);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      scriptPath: REVISED,
      trace: traceFor("script-path-amend-b"),
    });
    await vi.waitFor(() => {
      expect(scriptPathOf(harness, amended.runId)).toBe(REVISED);
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // Same predecessor, no field this time: the successor has no file (absent ≠ inherit the
    // predecessor's DRAFT). The predecessor's path points at the old script; if the port inherited here,
    // the model would next edit a file that is no longer running.
    const cleared = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("script-path-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, cleared.runId)).toBeDefined();
    });
    expect("scriptPath" in launchedOf(harness, cleared.runId)!).toBe(false);
    expect(await harness.service.cancel(cleared.runId)).toBe(true);
    await settle(harness, cleared.runId);
  });

  it("resume 从 run-launched 事件读回路径抄进条目：读面照旧「有条目就读条目」", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    expect(await harness.service.resume!(runId)).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });

    // The resumed generation's entry carries this path (the resume entry has no such parameter; the
    // only source is the event). The spy is the evidence for "read the entry when present": the
    // snapshot answers the path without issuing a single listEvents.
    const listEvents = vi.spyOn(harness.journal, "listEvents");
    expect(await harness.service.getTask(runId)).toMatchObject({ scriptPath: DRAFT });
    expect(listEvents).not.toHaveBeenCalled();
    listEvents.mockRestore();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });
});

describe("dynamic workflow run service — 发起锚点（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）", () => {
  const anchoredEvents = (harness: Harness) =>
    harness.runEvents.filter(
      (event) => event.eventType === "actor-created" || event.eventType === "run-settled",
    );

  it("活动轮命中 → journal 首条 run-launched 与 actor-created / run-settled 载荷带同一锚点", async () => {
    const trace = traceFor("anchor-active");
    const harness = makeHarness({
      resolveLaunchInputId: (candidate) =>
        candidate.turnId === trace.turnId ? "launch-input-active" : undefined,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("anchor-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: "tool-anchor",
      trace,
    });
    await settle(harness, runId);

    const events = harness.journal.listEvents(runId, { types: "all", reportItems: "all" });
    expect(events.slice(0, 2).map((stored) => stored.event.type)).toEqual([
      "run-started",
      "run-launched",
    ]);
    expect(events[1]?.event).toMatchObject({
      inputId: "launch-input-active",
      toolCallId: "tool-anchor",
    });
    const anchored = anchoredEvents(harness);
    expect(anchored.map((event) => event.eventType)).toEqual(["actor-created", "run-settled"]);
    expect(anchored.every((event) => event.launchInputId === "launch-input-active")).toBe(true);
    // Other events carry no derived field: the anchor is needed only at the two attribution moments.
    expect(
      harness.runEvents
        .filter((event) => event.eventType === "node-queued")
        .every((event) => event.launchInputId === undefined),
    ).toBe(true);
  });

  it("submit 的 phaseNames 落进 run-launched（journal 是唯一副本，冷重放免费重建）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-phases",
      phaseNames: ["Research", "Write"],
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-phases"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toEqual({
      type: "run-launched",
      inputId: "launch-input-phases",
      phaseNames: ["Research", "Write"],
    });
  });

  it("submit 的 phaseAlongside 与阶段表同车落 journal（service 只转发，不加工）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-alongside",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-alongside"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toEqual({
      type: "run-launched",
      inputId: "launch-input-alongside",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
    });
  });

  it("显式 launchInputId（中枢直接启动）优先于活动轮解析", async () => {
    const harness = makeHarness({ resolveLaunchInputId: () => "active-should-lose" });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-direct",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-direct"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toMatchObject({
      inputId: "launch-input-direct",
    });
    expect(
      anchoredEvents(harness).every((event) => event.launchInputId === "launch-input-direct"),
    ).toBe(true);
  });

  it("没有解析器也没有显式值 → 铸 UUID v7 锚点", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-minted"),
    });
    await settle(harness, runId);
    const launched = harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]
      ?.event;
    expect(launched?.type).toBe("run-launched");
    const inputId = launched?.type === "run-launched" ? launched.inputId : "";
    expect(inputId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(anchoredEvents(harness).every((event) => event.launchInputId === inputId)).toBe(true);
  });
});

describe("dynamic workflow run service — 产物存储的接线", () => {
  /** Fake store recording write parameters (text writes only: the script publishes markdown). */
  function recordingArtifactStore(): {
    store: ToolArtifactStorePort;
    writes: ToolArtifactWriteRequest[];
  } {
    const writes: ToolArtifactWriteRequest[] = [];
    return {
      writes,
      store: {
        writeToolResultArtifact: async (request) => {
          writes.push(request);
          return {
            id: "artifact-1",
            uri: "zcode-artifact://harness/artifact-1",
            bytes: Buffer.byteLength(request.content, "utf8"),
            contentType: request.contentType ?? "text/plain",
            createdAt: new Date(0),
          };
        },
        readToolResultArtifact: async () => {
          throw new Error("readToolResultArtifact 不应被本用例触及");
        },
      },
    };
  }

  it("store 经 service → launch → driver 送达，会话作用域是本服务的父会话", async () => {
    const { store, writes } = recordingArtifactStore();
    const harness = makeHarness({ artifactStore: store });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("some-other-session"),
      scriptText: ARTIFACT_SCRIPT,
      trace: traceFor("artifact-wiring"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.status).toBe("completed");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      // The **service's own** parent session, not the optional parentSessionId in the submit request:
      // in production the two are the same value, and only the former is required (which session's
      // directory the bytes go into must not have an undefined branch).
      sessionId: HARNESS_PARENT_SESSION,
      toolName: "CreateWorkflow",
      retention: "project",
      contentType: "text/markdown",
    });
    expect(String(writes[0]?.toolCallId)).toBe(`${runId}:artifact#1@1`);
  });

  it("不接 store 的装配里，发布以 ArtifactStoreUnavailable 拒绝而 run 照常结算", async () => {
    const harness = makeHarness();

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      // The script catches the rejection and yields the error code as its result: exactly the spec's gating idiom.
      scriptText: [
        "let code = 'none';",
        'try { await artifact.markdown("summary", "# 结论"); }',
        "catch (error) { code = (error as { code?: string }).code ?? 'unknown'; }",
        "return code;",
      ].join("\n"),
      trace: traceFor("artifact-no-store"),
    });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("ArtifactStoreUnavailable");
  });
});

// ── Read faces of user-facing artifacts (docs/dynamic-workflow/authoring.md "How the user sees them") ──────────────
// ⚠ Terminology: artifact = what the script publishes for the **user** to see via `artifact.*`, not the
// port's `output` (the script's top-level return value, the engine's internal namesake).
//
// Three port methods: listArtifacts (catalog) / listArtifactItems (board items) / readArtifact (bytes).
// readArtifact's authorization chain is the focus of this section: run belongs to this session ∧ the journal
// has a completed row for that version ⇒ only then read from the store via the **row's** uri. Every negative
// case asserts the store was **never touched**.
describe("dynamic workflow run service — 用户面产物的读面", () => {
  /** Fake store recording reads and writes; `readToolResultBinaryArtifact` returns the bytes it wrote by uri. */
  function readableArtifactStore(): {
    store: ToolArtifactStorePort;
    reads: string[];
  } {
    const bytesByUri = new Map<string, Uint8Array>();
    const reads: string[] = [];
    let next = 0;
    return {
      reads,
      store: {
        writeToolResultArtifact: async (request) => {
          next += 1;
          const uri = `zcode-artifact://harness/artifact-${next}`;
          bytesByUri.set(uri, new TextEncoder().encode(request.content));
          return {
            id: `artifact-${next}`,
            uri,
            bytes: Buffer.byteLength(request.content, "utf8"),
            contentType: request.contentType ?? "text/plain",
            createdAt: new Date(0),
          };
        },
        readToolResultArtifact: async () => {
          throw new Error(
            "字节读回必须走 readToolResultBinaryArtifact（文本读会毁掉 office 文件）",
          );
        },
        readToolResultBinaryArtifact: async (request) => {
          reads.push(request.uri);
          const bytes = bytesByUri.get(request.uri);
          if (bytes === undefined) throw new Error(`unknown uri: ${request.uri}`);
          // The store side re-derives a contentType from the filename, deliberately a **wrong** one:
          // the read face must use the one on the journal record (the UI's exact-match renderer-dispatch contract).
          return { uri: request.uri, bytes, contentType: "application/json" };
        },
      },
    };
  }

  /** Declare one board, feed it two tagged reports, then publish two markdown versions. */
  const MIXED_SCRIPT = [
    'artifact.chart("perf", { x: { field: "round" }, y: { field: "ms" } });',
    'report({ round: 1, ms: 40 }, "perf");',
    'report({ round: 2, ms: 31 }, "perf");',
    "report({ untagged: true });",
    'await artifact.markdown("summary", "# 第一版");',
    'await artifact.markdown("summary", "# 第二版");',
    'return "done";',
  ].join("\n");

  async function runMixed(overrides: { parentSessionId?: SessionId } = {}) {
    const { store, reads } = readableArtifactStore();
    const harness = makeHarness({ artifactStore: store });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: overrides.parentSessionId ?? HARNESS_PARENT_SESSION,
      scriptText: MIXED_SCRIPT,
      trace: traceFor("artifact-reads"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
    return { harness, runId, reads };
  }

  it("listArtifacts 按 id 分组、版本升序，顶层取最新版；看板带 itemCount、内容产物恒 0", async () => {
    const { harness, runId } = await runMixed();
    const artifacts = await harness.service.listArtifacts!(runId);

    expect(artifacts).toHaveLength(2);
    // Order = first-appearance order: the board is declared first, markdown published later.
    const [chart, summary] = artifacts!;
    // The untagged report counts toward no artifact.
    expect(chart).toMatchObject({ id: "perf", kind: "chart", version: 1, itemCount: 2 });
    expect(chart?.versions).toHaveLength(1);
    expect(summary).toMatchObject({
      id: "summary",
      kind: "markdown",
      version: 2,
      contentType: "text/markdown",
      itemCount: 0,
    });
    expect(summary?.versions.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("listArtifactItems 按 sequence 升序分页，afterSequence 严格大于，hasMore 由存储层判定", async () => {
    const { harness, runId } = await runMixed();
    const read = (page: { afterSequence?: number; limit: number }, artifactId = "perf") =>
      harness.service.listArtifactItems!(runId, artifactId, { ...page, maxBytes: 1 << 30 });
    const all = await read({ limit: 10 });
    expect(all.items.map((entry) => entry.item)).toEqual([
      { round: 1, ms: 40 },
      { round: 2, ms: 31 },
    ]);
    expect(all.items[0]?.siteId).toBe("report#1");
    expect(all.hasMore).toBe(false);

    // limit is exact: the storage layer never clamps it itself, and can tell whether more follows the page.
    const firstPage = await read({ limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    // The cursor is strictly greater-than.
    const secondPage = await read({ afterSequence: firstPage.items[0]!.sequence, limit: 10 });
    expect(secondPage.items.map((entry) => entry.item)).toEqual([{ round: 2, ms: 31 }]);
    // An out-of-range cursor yields an empty page, not an error — reaching the tail is a normal paging end.
    expect(await read({ afterSequence: 9_999, limit: 10 })).toEqual({ items: [], hasMore: false });
    // An unknown id is likewise an empty page (the untagged report belongs to no id).
    expect(await read({ limit: 10 }, "ghost")).toEqual({ items: [], hasMore: false });
  });

  it("readArtifact 回字节 + **journal 记录上的** contentType（不是 store 再推的那份）", async () => {
    const { harness, runId, reads } = await runMixed();
    const first = await harness.service.readArtifact!(runId, "summary", 1);
    const second = await harness.service.readArtifact!(runId, "summary", 2);

    expect(new TextDecoder().decode(first!.bytes)).toBe("# 第一版");
    expect(new TextDecoder().decode(second!.bytes)).toBe("# 第二版");
    // The store stand-in deliberately returns application/json; text/markdown on the record is the UI's dispatch contract.
    expect(first!.contentType).toBe("text/markdown");
    // Each version has its own uri — the version history is real, not the same bytes renumbered.
    expect(new Set(reads).size).toBe(2);
  });

  it("授权负例：run 的父会话不是本服务的 ⇒ 拒绝，且 store 一次都没被碰", async () => {
    // This is step ② of the authorization chain at spec line 177. The service instance is built per
    // parent session; bytes of another session's run must never flow out through this service.
    const { harness, runId, reads } = await runMixed({
      parentSessionId: createSessionId("some-other-session"),
    });
    expect(await harness.service.readArtifact!(runId, "summary", 1)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("授权负例：未知 runId / 未知 artifactId / 未知版本 ⇒ 拒绝，store 未被碰", async () => {
    const { harness, runId, reads } = await runMixed();
    expect(await harness.service.readArtifact!("dwfrun-nope", "summary", 1)).toBeUndefined();
    expect(await harness.service.readArtifact!(runId, "ghost", 1)).toBeUndefined();
    // Only two versions were published; version 3 does not exist — the version number is part of the authorization chain, not a skippable hint.
    expect(await harness.service.readArtifact!(runId, "summary", 3)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("授权负例：预置看板没有字节 ⇒ 拒绝（它的数据是 journal 里的标签 report 行）", async () => {
    const { harness, runId, reads } = await runMixed();
    expect(await harness.service.readArtifact!(runId, "perf", 1)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("store 缺席 / 不带二进制读回 ⇒ 整条读回缺席，绝不退回文本读再解码", async () => {
    // Falling back to a text read is exactly the bug recorded on ToolBinaryArtifactReadResult on
    // 2026-09-04: the store derived contentType from the filename, office extensions landed on
    // application/json, and decoding as utf8 corrupted the bytes.
    const textOnly: ToolArtifactStorePort = {
      writeToolResultArtifact: async (request) => ({
        id: "a1",
        uri: "zcode-artifact://harness/a1",
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      }),
      readToolResultArtifact: async () => {
        throw new Error("不带二进制能力的 store 不得被退回文本读");
      },
    };
    const harness = makeHarness({ artifactStore: textOnly });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARTIFACT_SCRIPT,
      trace: traceFor("artifact-read-textonly"),
    });
    await settle(harness, runId);
    expect(await harness.service.readArtifact!(runId, "summary", 1)).toBeUndefined();
  });

  it("引擎发出的事件真的能被共享 reducer 归约成 workflowRuns.artifacts（两半的接缝）", async () => {
    // This pins the **seam**, not either half: the reducer assumes `artifact-published`'s payload is
    // `{ instance, artifact: ArtifactVersionRecord }`, while the payload is actually emitted by the
    // engine and bounded via toProgressPayload. Both sides' unit tests green with mismatched shapes is
    // the most typical silent failure of this layering — the symptom is a side pane forever empty with
    // no error anywhere.
    const { harness, runId } = await runMixed();

    const published = harness.runEvents.filter((event) => event.eventType === "artifact-published");
    // One board declaration + two markdown versions = three; only failed publishes go through artifact-failed (this script has none).
    expect(published).toHaveLength(3);
    expect(harness.runEvents.some((event) => event.eventType === "artifact-failed")).toBe(false);
    // Artifact sites emit no node lifecycle events (slice 1's ruling: otherwise the projection would
    // reduce them into nodes[], adding an untracked node on the side pane that nobody can await).
    expect(
      published.every((event) => (event.payload as { instance?: unknown }).instance !== undefined),
    ).toBe(true);

    let state: WorkflowRunsState | undefined;
    for (const event of harness.runEvents) {
      state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
    }
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
      // bytes ride along on the record (the card displays the size); 11 = 2 heading bytes + 3 CJK chars × 3 bytes, the second-version markdown heading fixture.
      { id: "summary", kind: "markdown", version: 2, contentType: "text/markdown", bytes: 11 },
    ]);
    // The reduced state passes the strict schema — a live frame is never dropped whole over one extra/missing key.
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
    // Tagged reports still enter the Results section (one channel, one cap); the untagged one is there too.
    expect(state?.runs[0]?.reports?.map((report) => report.artifactId)).toEqual([
      "perf",
      "perf",
      undefined,
    ]);
  });

  it("零产物的 run：listArtifacts 整个缺席（不是空数组）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("artifact-none"),
    });
    await settle(harness, runId);
    expect(await harness.service.listArtifacts!(runId)).toBeUndefined();
  });
});

describe("dynamic workflow run service — actor sessions", () => {
  it("两个持久化调用都发生，且 task link 在会话落库之后", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("actor-parent"),
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-persist"),
    });
    await settle(harness, runId);

    // 1. ensureSessionPersistedForExternalActivity
    expect(harness.persistedTitles).toHaveLength(1);
    expect(harness.persistedTitles[0]).toContain("actor#1@1");
    // 2. createSessionTaskLink
    expect(harness.taskLinks).toHaveLength(1);
    const link = harness.taskLinks[0]!;
    expect(link.role).toBe("workflow_actor");
    expect(link.parentSessionId).toBe(createSessionId("actor-parent"));
    // Run identity goes through the FK-free path column: rootWorkflowRunId has an FK to legacy
    // workflow_run(id); filling a dwf runId there would reject every link with FOREIGN KEY constraint failed.
    expect(link.rootWorkflowRunId).toBeUndefined();
    expect(link.path).toContain(runId);
  });

  /**
   * Tripwire for the production wiring (amend-resume): the transcript face must travel from service deps
   * all the way into the driver's hands before boundaries can be written. Any link forgetting to pass it
   * through produces no compile error and the run finishes normally — only this run can **never be an
   * amendment predecessor** (the service's "reject marker-less predecessors wholesale" gate blocks it),
   * and the symptom sits far from the cause. Hence this case runs a real store: actor messages really
   * persist, and the boundary must equal the length counted through the same access face.
   */
  it("接上会话存储后，ask 节点带上消息数边界（service → launch → driver 的透传）", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-boundary-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const harness = makeHarness({ sessionStore: store as never });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("actor-boundary"),
      });
      await settle(harness, runId);

      const node = harness.journal.getNode(runId, "ask#1", 1);
      const actorSessionId = harness.actorRuntimeInputs[0]!.sessionId;
      const persisted = await store.messages({ sessionID: actorSessionId });
      expect(persisted.length).toBeGreaterThan(0);
      expect(node?.messageBoundary).toBe(persisted.length);
      // Read-modify-write: not one field the engine wrote may be lost.
      expect(node?.status).toBe("completed");
      expect(node?.actorSeq).toBe(0);
      expect(node?.stats?.tokens).toBeGreaterThan(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // Only one channel remains for the transcript live feed: the child runtime's **construction-time**
  // eventSink. The run service no longer subscribes itself — the old `onActorSessionEvent` +
  // subscribeEvents was installed after persist, while the SessionTitleUpdated written by persist is
  // seq 1, and the v4 gateway only drains contiguous seqs, so that subscription waited from seq 2
  // forever for a seq 1 that never came again (transcript permanently blank).
  // The driver's rate-limit observation subscription (exactly once per actor) is not a live channel:
  // it reads only ModelNetworkStatus, so missing seq 1 is harmless — hence this pins "exactly once
  // per actor", not zero.
  it("actor 事件只经构造期 sink 直播，subscribeEvents 只有 driver 的两个观察面（每 actor 各一次）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-live-channel"),
    });
    await settle(harness, runId);

    const actorSessionId = harness.actorRuntimeInputs[0]!.sessionId;
    expect(harness.sessionEvents.length).toBeGreaterThan(0);
    expect(
      harness.sessionEvents.every(
        (event) => (event as { sessionId: string }).sessionId === actorSessionId,
      ),
    ).toBe(true);
    expect(harness.actorSubscribeCalls).toEqual([actorSessionId, actorSessionId]);
    // One facet of the shared store: actor events land in the (in production, parent runtime's) store
    // under their own sessionId — exactly where v4 `loadPersistedEvents(actorSessionId)` reads.
    const stored = await harness.actorEventStore.getEvents(actorSessionId);
    expect(stored.length).toBe(harness.sessionEvents.length);
  });

  it("actor 会话 id 含 runId 且字符集安全", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-session-id"),
    });
    await settle(harness, runId);

    expect(harness.actorRuntimeInputs).toHaveLength(1);
    const sessionId = harness.actorRuntimeInputs[0]!.sessionId;
    expect(sessionId).toContain(runId);
    // refToString(actor) is `actor#1@1`: # and @ must already have been folded away.
    expect(sessionId).not.toMatch(/[#@/]/);
  });

  // The persistence sequence must be **per actor, at creation, atomic**: never batched into submit,
  // never deferred past the first ask. This pins exactly that degradation — if someone ever turns the
  // factory back to fire-and-forget, persistence and link-creation race the first turn, while
  // session_task_link.child_session_id's FK requires the session row to exist first.
  it("持久化在该 actor 的首个 turn 之前完成（不是 fire-and-forget）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("order-parent"),
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-order"),
    });
    await settle(harness, runId);

    const persistIndex = harness.order.findIndex((entry) => entry.startsWith("persist:"));
    const linkIndex = harness.order.findIndex((entry) => entry.startsWith("link:"));
    const turnIndex = harness.order.findIndex((entry) => entry.startsWith("turn:"));
    const constructIndex = harness.order.findIndex((entry) => entry.startsWith("construct:"));

    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThanOrEqual(0);
    expect(constructIndex).toBeGreaterThanOrEqual(0);
    // Runtime construction (= live sink installed) must precede persist: the SessionTitleUpdated
    // persist writes is seq 1, and a sink taking effect later would leave the v4 gateway's
    // contiguous drain waiting from seq 2 forever for seq 1.
    expect(constructIndex).toBeLessThan(persistIndex);
    // Session row → link creation (FK order) → only then may the first turn start.
    expect(persistIndex).toBeLessThan(linkIndex);
    expect(linkIndex).toBeLessThan(turnIndex);
  });

  it("dwf_actor.session_id 收到 driver 铸的会话 id", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-journal"),
    });
    await settle(harness, runId);

    const actors = harness.journal.listActors(runId, { withPersona: true });
    expect(actors).toHaveLength(1);
    expect(actors[0]!.sessionId).toBe(harness.actorRuntimeInputs[0]!.sessionId);
  });

  // The old scheme `wf-actor-${refToString(actor)}` carried no runId; the same site×ordinal actor
  // from two concurrent runs would collide into one session id.
  it("并发两个 run 的同 site×ordinal actor 不撞会话 id", async () => {
    const harness = makeHarness();
    const [first, second] = await Promise.all([
      submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("collide-a"),
      }),
      submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("collide-b"),
      }),
    ]);
    await Promise.all([settle(harness, first), settle(harness, second)]);

    expect(first).not.toBe(second);
    const sessionIds = harness.actorRuntimeInputs.map((input) => input.sessionId);
    expect(sessionIds).toHaveLength(2);
    expect(new Set(sessionIds).size).toBe(2);
  });
});

describe("dynamic workflow run service — cancellation", () => {
  it("cancel 使 run 结算为 cancelled 而不是 failed，且保留已完结 journal 条目", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("cancel-run"),
    });

    // Wait for the actor session to come up (ask dispatched, turn in flight), then cancel.
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    // Failure is never encoded as a stop, nor a stop as failure: the two carry different semantics
    // and resume UX in the journal. The snapshot base's status is the background-task tracker's
    // generic vocabulary (stopped → cancelled); the real word lives in runStatus.
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("user");
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
    expect(harness.journal.getRun(runId)?.stopReason).toBe("user");

    // Persisted actor records are kept (a cancelled run can resume).
    expect(harness.journal.listActors(runId, { withPersona: true })).toHaveLength(1);
  });

  it("未知 run 的 cancel 返回 false", async () => {
    const harness = makeHarness();
    expect(await harness.service.cancel("dwfrun-does-not-exist")).toBe(false);
  });

  it("已结算 run 的 cancel 返回 false", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("cancel-settled"),
    });
    await settle(harness, runId);

    expect(await harness.service.cancel(runId)).toBe(false);
  });
});

/**
 * Close (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership" rule 2).
 *
 * The engine lives in this App's closure; once the App closes it has no host. So closing stops it
 * actively: abort every in-flight entry with `"interrupted"` and wait for settlement; that final write
 * **belongs to the engine itself** (updateRunStatus + run-settled + driver dispose) — the service adds
 * not one word, since writing around the engine would create a second writer of dwf_run.
 */
describe("dynamic workflow run service — close（Engine ownership 规则二）", () => {
  /** The run's current max event sequence in the journal; used to prove "no events after close". */
  function maxSequence(harness: Harness, runId: string): number {
    return harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .reduce((max, entry) => Math.max(max, entry.sequence), 0);
  }

  it("close 停下在飞 run：行为 stopped(interrupted) + Interrupted，且由引擎写下", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-live"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    expect(harness.service.countLiveRuns()).toBe(1);

    await harness.service.close();

    // Settlement is already complete when close resolves: no need to waitForTask again.
    expect(harness.service.countLiveRuns()).toBe(0);
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("stopped");
    // interrupted, not user: the UI reads user as "the user pressed stop", but here the host stopped it on its behalf.
    expect(record?.stopReason).toBe("interrupted");
    expect(record?.failure?.code).toBe("Interrupted");
    expect(record?.failure?.message).toContain("the owning session closed");
    expect(record?.failure?.message).toContain(runId);

    // The entry's final state is in place; the snapshot speaks "stopped" (resumable).
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("interrupted");

    // The engine's own write: the journal has run-settled, not a bare status line backfilled by the service.
    const settled = harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .filter(({ event }) => event.type === "run-settled");
    expect(settled).toHaveLength(1);

    // The journal grows no further after close: settlement is written before close resolves, with no straggler events after.
    const sequenceAtClose = maxSequence(harness, runId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxSequence(harness, runId)).toBe(sequenceAtClose);
  });

  it("close 等结算：在飞 run 未结算前 close 不解析", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-awaits"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    let settledFirst: string | undefined;
    const unsubscribe = harness.service.subscribeRunSettled((notice) => {
      settledFirst ??= `settled:${notice.runId}`;
    });
    let resolved = false;
    const closing = harness.service.close().then(() => {
      resolved = true;
    });
    // Settlement relies on the real abort → engine stop → finishRun chain — not something one microtask can finish.
    expect(resolved).toBe(false);
    await closing;
    expect(resolved).toBe(true);
    // The settlement notification precedes close resolving: close waits for exactly the tail of that chain.
    expect(settledFirst).toBe(`settled:${runId}`);
    unsubscribe();
  });

  it("关闭之后 submit / amend / resume 抛接线错误（而不是结构化拒绝）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-refuses"),
    });
    await settle(harness, runId);
    await harness.service.close();

    await expect(
      harness.service.submit({
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("close-refuses-submit"),
      }),
    ).rejects.toThrow(/service is closed/);
    await expect(harness.service.resume!(runId)).rejects.toThrow(/service is closed/);
    await expect(
      harness.service.amend!({
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        predecessorRunId: runId,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("close-refuses-amend"),
      }),
    ).rejects.toThrow(/service is closed/);
  });

  it("零在飞 run 时 close 直接解析；第二次 close 返回同一个 promise，不再 abort", async () => {
    const harness = makeHarness();
    const first = harness.service.close();
    const second = harness.service.close();
    // Idempotency comes from remembering the promise, not from re-running the close flow.
    expect(second).toBe(first);
    await first;
    const closing = harness.logs.filter(
      (entry) => entry.context?.event === "dynamic_workflow.service.closing",
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.context?.liveRunCount).toBe(0);
  });
});

/**
 * Foreign terminal rows (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership" rule 3).
 *
 * Bug root cause (2026-09-04 / 2026-09-15): a second desktop instance cold-recovered the same session
 * and its orphan convergence wrote terminal rows onto runs whose engines were **still alive** in this
 * process. This process accepted them wholesale: the tracker got a terminal snapshot, told the model the
 * run ended, marked the task done, and the real completion was then discarded — the row ended as
 * completed while still carrying that stale failure.
 *
 * The assembly parks the run on a genuinely live node via an escalation question (escalate does not
 * end the turn; it keeps working after the answer), so the same run can be both observed and released
 * to run to completed.
 */
describe("dynamic workflow run service — 外来终态行（Engine ownership 规则三）", () => {
  const FOREIGN_FAILURE = { code: "Interrupted" as const, message: "owning process exited" };

  /** Start a run parked on an escalation question; returns the runId and qid. */
  async function parkedRun(
    harness: Harness,
    name: string,
  ): Promise<{ runId: string; qid: string }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(async () => {
      expect((await harness.service.getTask(runId))?.pendingQuestions).toHaveLength(1);
    });
    const qid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    if (qid === undefined) throw new Error("停驻的问题没有出现在快照里");
    return { runId, qid };
  }

  function parkedHarness(answer: string, journal?: JournalStorePort): Harness {
    return makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: "外来写入期间先停在这里" },
          { kind: "submit", result: { text: answer } },
        ],
      },
      ...(journal === undefined ? {} : { journal }),
    });
  }

  // Runs a real store: two of the four read faces (listRuns / getRunDetail) attach via capability
  // probing, absent from the stand-ins; and what this case proves is exactly **one answer across all four**.
  it("四条读面都忽略活条目下的外来终态行，警告每个条目只记一次", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = parkedHarness("真正的结果", journal);
      const { runId } = await parkedRun(harness, "foreign-row");

      // The second instance's orphan convergence: writes a terminal row straight into the journal; this process's registry knows nothing.
      harness.journal.updateRunStatus(runId, "stopped", {
        stopReason: "interrupted",
        failure: FOREIGN_FAILURE,
      });
      expect(harness.journal.getRun(runId)?.status).toBe("stopped");

      // (1) Snapshot: still running; none of the three terminal fields appears.
      const snapshot = await harness.service.getTask(runId);
      expect(snapshot?.status).toBe("running");
      expect(snapshot).not.toHaveProperty("runStatus");
      expect(snapshot).not.toHaveProperty("stopReason");
      expect(snapshot).not.toHaveProperty("failure");
      expect(snapshot).not.toHaveProperty("error");

      // (2) List and (3) detail: the same answer as the snapshot (three-way divergence is harder to catch than three-way wrong).
      const introspection = introspectionOf(harness);
      const { runs: listed } = await introspection.listRuns({ cwd: TEST_CWD, limit: 20 });
      const row = listed.find((item) => item.runId === runId);
      expect(row?.status).toBe("running");
      expect(row).not.toHaveProperty("stopReason");
      const detail = await introspection.getRunDetail(runId);
      expect(detail?.status).toBe("running");
      expect(detail).not.toHaveProperty("stopReason");
      expect(detail).not.toHaveProperty("error");
      expect(detail).not.toHaveProperty("result");

      // (4) The session enumeration face (it has no registry of its own; the service hands entries in).
      const sessionRows = await harness.service.listRunsForSession(20);
      const sessionRow = sessionRows.find((item) => item.runId === runId);
      expect(sessionRow?.status).toBe("running");
      expect(sessionRow).not.toHaveProperty("stopReason");
      expect(sessionRow).not.toHaveProperty("failureCode");
      expect(sessionRow?.resumable).toBe(false);

      // Leaves a trace without flooding: the tracker polls every second; the warning logs once per entry.
      await harness.service.getTask(runId);
      await harness.service.getTask(runId);
      const warns = harness.logs.filter(
        (entry) => entry.context?.event === "dynamic_workflow.run.foreign_terminal_row",
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]?.context).toMatchObject({
        journalStatus: "stopped",
        runId,
        stopReason: "interrupted",
      });

      // Wrap-up: let the run really finish; don't leave a live engine for the next case.
      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("引擎自己的结算改写那一行：completed 且不带陈旧失败", async () => {
    const harness = parkedHarness("真正的结果");
    const { runId, qid } = await parkedRun(harness, "foreign-row-then-settle");
    harness.journal.updateRunStatus(runId, "stopped", {
      stopReason: "interrupted",
      failure: FOREIGN_FAILURE,
    });

    // Release: the actor gets its answer, keeps working, and submits.
    expect(await harness.service.resolveQuestion(qid, "继续")).toMatchObject({ ok: true });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.runStatus).toBe("completed");
    expect(snapshot?.output).toBe("真正的结果");
    expect(snapshot).not.toHaveProperty("failure");
    // The storage-side other half (the journal contract's "clears a stale failure…"): a completed row carries no failure.
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("completed");
    expect(record?.failure).toBeUndefined();
    expect(record?.stopReason).toBeUndefined();
  });

  it("外来终态行期间 waitForTask 仍然等真正的结算", async () => {
    const harness = parkedHarness("等到了");
    const { runId, qid } = await parkedRun(harness, "foreign-row-wait");
    harness.journal.updateRunStatus(runId, "stopped", {
      stopReason: "interrupted",
      failure: FOREIGN_FAILURE,
    });

    let resolved = false;
    const waiting = harness.service.waitForTask(runId).then((snapshot) => {
      resolved = true;
      return snapshot;
    });
    // The row is already terminal, but what is awaited is the entry's settlement promise — still unfulfilled.
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(await harness.service.resolveQuestion(qid, "继续")).toMatchObject({ ok: true });
    expect((await waiting)?.status).toBe("completed");
    expect(resolved).toBe(true);
  });
});

describe("dynamic workflow run service — observation", () => {
  it("未知 run 的 getTask 返回 undefined", async () => {
    const harness = makeHarness();
    expect(await harness.service.getTask("dwfrun-unknown")).toBeUndefined();
  });

  // The tracker polls immediately after submit returns, while the dwf_run row waits for engine
  // construction. At that moment the snapshot must read running, or the first poll judges the
  // just-started run as lost.
  it("submit 刚返回时快照已是 running", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("snapshot-immediate"),
    });

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.runId).toBe(runId);

    await harness.service.cancel(runId);
    await settle(harness, runId);
  });

  // The restart-recovery face of the live-desktop bug: after a process restart the registry is empty
  // and the snapshot can only be synthesized from journal records. A completed record with a result
  // must surface it as output, or TaskOutput can never retrieve the artifact after restart.
  it("重启恢复：注册表为空时 completed 记录的 result 作为 output 回出", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart", status: "running" });
    journal.updateRunStatus("dwfrun-restart", "completed", {
      result: { report: "final answer", steps: 3 },
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toEqual({ report: "final answer", steps: 3 });
  });

  it("重启恢复：completed 但记录无 result 时 output 缺席", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart-empty", status: "running" });
    journal.updateRunStatus("dwfrun-restart-empty", "completed");
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart-empty");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot && "output" in snapshot).toBe(false);
  });

  it("重启恢复：failed 记录不回 output", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart-failed", status: "running" });
    journal.updateRunStatus("dwfrun-restart-failed", "errored", {
      failure: { code: "DriverError", message: "script threw" },
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart-failed");
    expect(snapshot?.status).toBe("failed");
    expect(snapshot?.runStatus).toBe("errored");
    expect(snapshot && "output" in snapshot).toBe(false);
    expect(snapshot?.error).toBe("script threw");
  });

  // ── Terminal snapshots carry incremental artifacts (the completion notification's data source) ──
  //
  // Items come from the journal's kind="report" rows, not the memory-only workflowRuns projection:
  // that is their durable home, still there after restart. The notification can therefore recover
  // mid-way artifacts on failed / cancelled too.

  function preloadReports(journal: JournalStorePort, runId: string, items: unknown[]): void {
    items.forEach((item, index) => {
      journal.putNode({
        runId,
        siteId: "report#1",
        ordinal: index + 1,
        kind: "report",
        inputHash: `hash-${index}`,
        status: "completed",
        result: item,
      });
    });
  }

  it("终态快照带 journal 里的 report 条目，按报告顺序", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports", status: "running" });
    preloadReports(journal, "dwfrun-reports", ["first finding", { file: "a.ts" }]);
    journal.updateRunStatus("dwfrun-reports", "completed", { result: "done" });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-reports");
    expect(snapshot?.reports).toEqual(["first finding", { file: "a.ts" }]);
    expect(snapshot?.output).toBe("done");
  });

  it("失败与取消的 run 一样带 reports（这条是 report 特性的目的）", async () => {
    for (const [status, taskStatus] of [
      ["errored", "failed"],
      ["stopped", "cancelled"],
    ] as const) {
      const journal = new SweepableJournalStore();
      const runId = `dwfrun-reports-${status}`;
      preloadRun(journal, { runId, status: "running" });
      preloadReports(journal, runId, ["finding before the end"]);
      journal.updateRunStatus(journal.getRun(runId)!.runId, status, {
        ...(status === "stopped" ? { stopReason: "user" as const } : {}),
        failure: { code: "DriverError", message: "boom" },
      });
      const harness = makeHarness({ journal });

      const snapshot = await harness.service.getTask(runId);
      expect(snapshot?.status).toBe(taskStatus);
      expect(snapshot?.runStatus).toBe(status);
      expect(snapshot?.reports).toEqual(["finding before the end"]);
    }
  });

  it("ask / world-read 节点不混进 reports；零条时字段整个缺席", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports-mixed", status: "running" });
    journal.putNode({
      runId: "dwfrun-reports-mixed",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "hash-ask",
      status: "completed",
      result: "an ask result, not a report",
    });
    journal.updateRunStatus("dwfrun-reports-mixed", "completed");
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-reports-mixed");
    expect(snapshot?.status).toBe("completed");
    // Absent rather than an empty array: the notification side drops the whole <reports> section on this, sending no empty section.
    expect(snapshot && "reports" in snapshot).toBe(false);
  });

  /**
   * Not read while in flight: `getTask` is polled repeatedly by the background tracker while
   * `listNodes` is a full table scan. Its only consumer is the terminal notification; reading it
   * mid-run has no reader, only cost.
   */
  it("running 的快照不读 report 节点（避免每次轮询扫全表）", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports-running", status: "running" });
    preloadReports(journal, "dwfrun-reports-running", ["mid-run finding"]);
    const harness = makeHarness({ journal });
    const listNodes = vi.spyOn(journal, "listNodes");

    const snapshot = await harness.service.getTask("dwfrun-reports-running");
    expect(snapshot?.status).toBe("running");
    expect(snapshot && "reports" in snapshot).toBe(false);
    expect(listNodes).not.toHaveBeenCalled();
  });

  // In-memory terminal state wins: a run this process just settled uses the artifact handed back by the engine, not the journal record.
  it("内存终态的 artifact 优先于 journal 记录的 result", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("in-memory-wins"),
    });
    await settle(harness, runId);
    // The journal side was rewritten to another value; the in-memory terminal state stays authoritative.
    journal.updateRunStatus(runId, "completed", { result: "journal-side value" });

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("done");
  });

  it("listEvents 按 cursor 分页且越界返回空页", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events"),
    });
    await settle(harness, runId);

    const { events: all, hasMore: allHasMore } = await harness.service.listEvents(runId, {});
    expect(allHasMore).toBe(false);
    expect(all.length).toBeGreaterThan(0);
    // sequence is monotonic; the payload is the event object minus the type field.
    expect(all[0]!.type).toBe("run-started");
    expect(all[0]!.payload).toMatchObject({ runId });
    expect(all.map((event) => event.sequence)).toEqual(
      [...all.map((event) => event.sequence)].sort((a, b) => a - b),
    );

    const { events: firstPage, hasMore } = await harness.service.listEvents(runId, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(hasMore).toBe(true);
    const { events: secondPage } = await harness.service.listEvents(runId, {
      afterSequence: firstPage[1]!.sequence,
      limit: 2,
    });
    // Page boundaries neither overlap nor skip.
    expect(secondPage[0]!.sequence).toBeGreaterThan(firstPage[1]!.sequence);

    const beyond = await harness.service.listEvents(runId, {
      afterSequence: all[all.length - 1]!.sequence + 1000,
    });
    expect(beyond).toEqual({ events: [], hasMore: false });
  });

  it("listEvents 不给 limit 时一页 500 条（事件日志从不一次读完）", async () => {
    // docs/execution-engine.md "Reading the journal": v4 workflowRunEvents' limit is optional, and
    // its absence used to mean reading the whole event log at once — a report-heavy run is a
    // GiB-scale item.
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events-page-cap"),
    });
    await settle(harness, runId);
    for (let i = 0; i < 600; i += 1) {
      harness.journal.appendEvent(runId, { type: "log", message: `line ${i}` });
    }

    const page = await harness.service.listEvents(runId, {});
    expect(page.events).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    // An explicit limit is honored as-is (the v4 gateway already clamps per schema).
    const asked = await harness.service.listEvents(runId, { limit: 501 });
    expect(asked.events).toHaveLength(501);
    const small = await harness.service.listEvents(runId, { limit: 3 });
    expect(small.events).toHaveLength(3);
  });

  it("journal 能按字节翻页时，listEvents 走它并带上协议的两道缺省界", async () => {
    // Only SQLite's listEventPage can honor the byte bound (it reads payload length from the row
    // header, not the payload); when the caller gives none, the service supplies both per protocol
    // caps, with hasMore taken verbatim from the storage layer's verdict.
    const calls: Array<{ afterSequence?: number; limit: number; maxBytes: number }> = [];
    class PagingJournal extends SweepableJournalStore {
      listEventPage(
        runId: string,
        query: { afterSequence?: number; limit: number; maxBytes: number },
      ) {
        calls.push(query);
        const events = this.listEvents(runId, { types: "all", reportItems: "all" }).slice(0, 1);
        return { events, hasMore: true };
      }
    }
    const harness = makeHarness({ journal: new PagingJournal() });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events-byte-pages"),
    });
    await settle(harness, runId);

    const page = await harness.service.listEvents(runId, {});
    expect(calls).toEqual([
      {
        limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
        maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      },
    ]);
    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  // ── The seam of the progress projection (docs/dynamic-workflow/presentation.md "The run state the pane draws") ──
  // What the hook hands over is the **already-prepared session event payload**: journal sequence,
  // bounded payload, plus the two derived fields that do not exist on Boundary C. create-app only
  // appends it to the parent session.

  it("钩子携带的 sequence 就是 journal sequence（与 listEvents 同一把尺）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId(),
      trace: traceFor("run-progress-sequence"),
    });
    await settle(harness, runId);

    const { events: journalPage } = await harness.service.listEvents(runId, {});
    // Aligned item by item: the same event must carry the same sequence and kind for both consumers.
    expect(harness.runEvents.map((event) => [event.sequence, event.eventType])).toEqual(
      journalPage.map((event) => [event.sequence, event.type]),
    );
    // Monotonic and starting at 0 (appendEvent's allocation semantics).
    expect(harness.runEvents.map((event) => event.sequence)).toEqual(
      harness.runEvents.map((_, index) => index),
    );
  });

  it("actor-created 携带 actor 会话 id，且与 driver 真正使用的那个一致", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-actor"),
    });
    await settle(harness, runId);

    const created = harness.runEvents.find((event) => event.eventType === "actor-created");
    // This assertion is the tripwire between "deterministic minting" and "what the driver actually
    // minted": the session id is the phase-5 drill-down entry; once the two drift, the detail page
    // opens a session that does not exist.
    expect(created?.actorSessionId).toBe(harness.actorRuntimeInputs[0]?.sessionId);
    expect(created?.actorSessionId).toContain(runId);
  });

  it("usage-updated 载荷自带已花 token，且等于 journal 列值（同一同步步骤产生）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-usage"),
    });
    await settle(harness, runId);

    const usage = harness.runEvents.filter((event) => event.eventType === "usage-updated");
    expect(usage.length).toBeGreaterThan(0);
    const last = usage.at(-1)!;
    // docs/dynamic-workflow/authoring.md "Usage, not budget": the event payload and dwf_run.spent_tokens are always equal.
    expect(last.payload.spentTokens).toBe(harness.journal.getRun(runId)?.spentTokens);
    expect(last.payload.spentTokens).toBeGreaterThan(0);
    // No more derived fields: the payload is exactly what the engine emitted.
    expect("spentTokens" in last).toBe(false);
  });

  it("载荷有界：超长 persona system prompt 被截断并置 truncated", async () => {
    const harness = makeHarness();
    const longPrompt = "x".repeat(5_000);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: [
        "interface Answer { text: string }",
        `const a = await agent("worker", ${JSON.stringify(longPrompt)}).ask<Answer>("go");`,
        "return a.text;",
      ].join("\n"),
      trace: traceFor("run-progress-bounds"),
    });
    await settle(harness, runId);

    const created = harness.runEvents.find((event) => event.eventType === "actor-created");
    const persona = created?.payload.persona as { system?: string } | undefined;
    expect(created?.truncated).toBe(true);
    expect(persona?.system?.length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength);
    // The same serialization also feeds listEvents: both consumers get the same bounded payload.
    const { events: page } = await harness.service.listEvents(runId, {});
    const pageCreated = page.find((event) => event.type === "actor-created");
    expect((pageCreated?.payload.persona as { system?: string }).system?.length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
    );
    expect(pageCreated?.truncated).toBe(true);
  });

  it("终态事件永远落地：run-settled 是权威收口", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-terminal"),
    });
    await settle(harness, runId);

    const settled = harness.runEvents.at(-1);
    expect(settled?.eventType).toBe("run-settled");
    expect(settled?.payload.status).toBe("completed");
  });

  it("钩子的 routing 携带 parentSessionId：事件必须落在发起该 run 的会话里", async () => {
    // The identity gate's other half lives in createDynamicWorkflowRunProgressSink; this proves the
    // run service really handed the identity over (otherwise the gate could only admit through the
    // lenient "absent means this session" branch — a gate in name only).
    const harness = makeHarness();
    const parentSessionId = createSessionId("run-progress-routing-parent");
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-routing"),
    });
    await settle(harness, runId);

    expect(harness.runEventRoutings.length).toBe(harness.runEvents.length);
    expect(new Set(harness.runEventRoutings.map((routing) => routing.parentSessionId))).toEqual(
      new Set([parentSessionId]),
    );
  });

  it("submit 未带 parentSessionId 时 routing 里就没有它（缺席，不是空串）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-routing-absent"),
    });
    await settle(harness, runId);

    expect(harness.runEventRoutings.every((routing) => !("parentSessionId" in routing))).toBe(true);
  });

  it("钩子抛错不打挂 run（观察者边界吞异常）", async () => {
    const harness = makeHarness({
      onRunEvent: () => {
        throw new Error("hook blew up");
      },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-hook-throws"),
    });
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("completed");
  });
});

describe("dynamic workflow run service — 孤儿 run 收敛", () => {
  // Live-desktop bug (2026-08-19, dwfrun-734d1f9d): the process was killed after run-started and the
  // dwf_run row **stayed running forever** — getTask/waitForTask answer runs absent from this
  // process's registry with the journal snapshot directly, so after recovering the session every
  // journal read face is told "still running", never self-healing. The convergence moment is the
  // next app construction of this parent session: at that instant this service instance has zero
  // in-flight runs, and any non-terminal row for this session in the journal can only be a dead
  // process's leftover.
  it("构造时把本会话的非终态 run 收敛成 failed（interrupted 编码）", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-running",
      status: "running",
    });
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-pending",
      status: "pending",
    });

    makeHarness({ journal });

    for (const runId of ["dwfrun-orphan-running", "dwfrun-orphan-pending"]) {
      const record = journal.getRun(runId);
      expect(record?.status).toBe("stopped");
      expect(record?.stopReason).toBe("interrupted");
      // The failure encoding follows the engine's WorkflowErrorJson shape, and its code must be
      // distinct both from "the script genuinely failed" (the harness encodes script throws as
      // DriverError) and from "user cancelled" (stopped(user), resumable).
      expect(record?.failure?.code).toBe("Interrupted");
      expect(record?.failure?.message).toContain(runId);
    }
  });

  it("每个被收敛的 run 记一条 warn（带 runId）", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-logged",
      status: "running",
    });

    const harness = makeHarness({ journal });

    const warnings = harness.logs.filter(
      (entry) => entry.level === "warn" && entry.context?.runId === "dwfrun-orphan-logged",
    );
    expect(warnings).toHaveLength(1);
  });

  it("本会话的终态 run 一律不动", () => {
    const journal = new SweepableJournalStore();
    for (const status of ["completed", "errored", "stopped"] as const) {
      preloadRun(journal, {
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: `dwfrun-terminal-${status}`,
        status,
      });
    }

    makeHarness({ journal });

    for (const status of ["completed", "errored", "stopped"] as const) {
      const record = journal.getRun(`dwfrun-terminal-${status}`);
      expect(record?.status).toBe(status);
      // The terminal row may not even have a failure reason backfilled: stopped means "user cancelled, resumable", not interrupted.
      expect(record?.failure).toBeUndefined();
    }
  });

  // Never sweep globally: the run service is constructed per-app (= per parent session); sibling
  // sessions in one process each have their own in-memory registry while sharing one sqlite. A sweep
  // without parentSessionId would mark other sessions' **in-flight** runs dead. Rows with no parent
  // session likewise do not belong to this session.
  it("别的会话（以及无父会话）的非终态 run 不动", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: createSessionId("sibling-session"),
      runId: "dwfrun-sibling-live",
      status: "running",
    });
    preloadRun(journal, { runId: "dwfrun-orphaned-parentless", status: "running" });

    makeHarness({ journal });

    expect(journal.getRun("dwfrun-sibling-live")?.status).toBe("running");
    expect(journal.getRun("dwfrun-orphaned-parentless")?.status).toBe("running");
  });

  it("构造后 submit 的 run 不受收敛影响", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-before-submit",
      status: "running",
    });
    const harness = makeHarness({ journal });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("sweep-then-submit"),
    });
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    expect(journal.getRun(runId)?.failure).toBeUndefined();
    expect(journal.getRun("dwfrun-orphan-before-submit")?.status).toBe("stopped");
  });

    // This is the bug's user-visible face: whatever the journal snapshot returns is what TaskOutput shows after session recovery.
  it("getTask 对被收敛的 run 回 stopped(interrupted) 并带失败原因", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-snapshot",
      status: "running",
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-orphan-snapshot");
    // Tracker vocabulary: stopped → cancelled; the real word and reason live on runStatus / stopReason.
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("interrupted");
    expect(snapshot?.failure?.code).toBe("Interrupted");
    expect(snapshot?.error).toContain("dwfrun-orphan-snapshot");
  });

  // Synthesize no dwf_event: the event log's contract is "what the engine emitted"; state authority
  // lives on the run row. run-settled is the engine's closing write, not the sweeper's.
  it("收敛不给事件日志添任何一条事件", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-events",
      status: "running",
    });
    journal.appendEvent("dwfrun-orphan-events", {
      caps: { maxConcurrency: 4 },
      runId: "dwfrun-orphan-events",
      type: "run-started",
    });

    const harness = makeHarness({ journal });

    const { events } = await harness.service.listEvents("dwfrun-orphan-events", {});
    expect(events.map((event) => event.type)).toEqual(["run-started"]);
  });

  it("二次构造幂等：没有可收敛项时一次写入都没有", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-idempotent",
      status: "running",
    });

    makeHarness({ journal });
    expect(journal.getRun("dwfrun-orphan-idempotent")?.status).toBe("stopped");

    const updateRunStatus = vi.spyOn(journal, "updateRunStatus");
    makeHarness({ journal });
    expect(updateRunStatus).not.toHaveBeenCalled();
  });

  // Must neither crash nor pretend convergence happened when the journal implementation lacks the
  // narrow query: skip and record the reason (visible degradation).
  it("journal 不带窄查询时跳过收敛并记原因", () => {
    const journal = new InMemoryJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-no-query",
      status: "running",
    });

    const harness = makeHarness({ journal });

    expect(journal.getRun("dwfrun-no-query")?.status).toBe("running");
    expect(
      harness.logs.some((entry) => JSON.stringify(entry.context ?? {}).includes("non_terminal")),
    ).toBe(true);
  });

  // Tripwire for the production wiring. The narrow query is **capability-probed** (it is not on the
  // engine's JournalStorePort), so any drift in the method name or signature raises no compile error —
  // it just makes convergence silently skip, regressing to the "orphan run stuck running forever" bug.
  // This case therefore runs the real sqlite session store, the production
  // resolveDynamicWorkflowJournalStore path.
  it("真实 sqlite journal 上收敛生效，且只碰本会话", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-sweep-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const journal = resolveDynamicWorkflowJournalStore(store as never);
      expect(journal).toBeDefined();

      preloadRun(journal!, {
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: "dwfrun-sqlite-orphan",
        status: "running",
      });
      preloadRun(journal!, {
        parentSessionId: createSessionId("sqlite-sibling"),
        runId: "dwfrun-sqlite-sibling",
        status: "running",
      });
      journal!.appendEvent("dwfrun-sqlite-orphan", {
        caps: { maxConcurrency: 4 },
        runId: "dwfrun-sqlite-orphan",
        type: "run-started",
      });

      const harness = makeHarness({ journal: journal! });

      const reconciled = journal!.getRun("dwfrun-sqlite-orphan");
      expect(reconciled?.status).toBe("stopped");
      expect(reconciled?.stopReason).toBe("interrupted");
      expect(reconciled?.failure?.code).toBe("Interrupted");
      expect(journal!.getRun("dwfrun-sqlite-sibling")?.status).toBe("running");
      // State authority lives on the run row; the event log still has only what the engine emitted.
      expect((await harness.service.listEvents("dwfrun-sqlite-orphan", {})).events).toHaveLength(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

// ————————————————————————————————————————————————————————————————
// Run introspection (listRuns / getRunDetail)
// See docs/dynamic-workflow/launch.md
// ————————————————————————————————————————————————————————————————

/**
 * This project's cwd and the "other project's" cwd (cwd is the project key, matched by literal equality).
 *
 * Must be **real existing directories**: a live run uses one as the sandbox subprocess's cwd; a
 * missing path makes spawn fail outright and the run settle failed — at which point the thing under
 * test is no longer truth synthesis. (Genuinely hit while writing these cases: two fake literal
 * paths originally turned every in-flight case's run into failed.)
 */
let projectCwd = "";
let otherCwd = "";
let introspectCwdRoot = "";

beforeAll(async () => {
  introspectCwdRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-cwd-"));
  projectCwd = join(introspectCwdRoot, "project");
  otherCwd = join(introspectCwdRoot, "other");
  await mkdir(projectCwd, { recursive: true });
  await mkdir(otherCwd, { recursive: true });
});

afterAll(async () => {
  await rm(introspectCwdRoot, { force: true, recursive: true });
});

/**
 * Introspection cases on a real sqlite journal.
 *
 * This family **must run on a real database**: the four introspection queries are not on the engine's
 * JournalStorePort — they attach via capability probing — so rewriting them in JS inside a stand-in
 * swaps the semantics under test for a replica, and drift's symptoms are precisely "capability silently
 * absent" or "counts/tails look right but the SQL is another thing". The queries' own semantics (cwd
 * pushdown, ordering, limit clamping) are pinned against a real database in
 * `adapters/tests/dwf-journal-store.test.ts`; what is pinned here is the service-side **truth synthesis**.
 */
async function withSqliteJournal(
  run: (journal: JournalStorePort & DwfRunIntrospectionQueries) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-introspect-"));
  const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  try {
    const journal = resolveDynamicWorkflowJournalStore(store as never);
    expect(journal).toBeDefined();
    await run(journal as JournalStorePort & DwfRunIntrospectionQueries);
  } finally {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  }
}

/** The port's two optional members: implemented when the capability is present; absence fails the case (rather than silently skipping assertions). */
function introspectionOf(harness: Harness): {
  getRunDetail: (runId: string) => Promise<DynamicWorkflowRunDetail | undefined>;
  listRuns: (query: DynamicWorkflowRunListQuery) => Promise<DynamicWorkflowRunListResult>;
} {
  const { getRunDetail, listRuns } = harness.service;
  return { getRunDetail: getRunDetail!, listRuns: listRuns! };
}

/**
 * A forwarding layer that hides selected runIds from the **read faces**: simulates the submit →
 * createRun microtask gap (registry already has the entry, the journal has no row yet).
 *
 * Why "hide reads" instead of "hold writes": dwf_event / dwf_node both carry an FK to dwf_run(id);
 * actually holding createRun would make the engine's first run-started event insert fail and the run
 * turn failed outright — no longer testing the gap. Hiding reads produces exactly the state the
 * service can see inside the gap: a registry hit that neither `getRun` nor `listRuns` recognizes.
 *
 * Forwards method by method (no spread): both journal implementations are classes; `{...journal}`
 * copies only own properties and every prototype method would be lost (same argument as
 * createJournalSequenceCapture).
 */
function hideRunsFromReads(
  journal: JournalStorePort & DwfRunIntrospectionQueries,
  hidden: ReadonlySet<string>,
): JournalStorePort & DwfRunIntrospectionQueries {
  return {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => (hidden.has(runId) ? undefined : journal.getRun(runId)),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId, opts) => journal.listActors(runId, opts),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal, opts) => journal.getNode(runId, siteId, ordinal, opts),
    listNodes: (runId, opts) => journal.listNodes(runId, opts),
    countNodes: (runId, kind) => journal.countNodes(runId, kind),
    appendEvent: (runId, event) => journal.appendEvent(runId, event),
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
    countNodesByStatus: (runId) => journal.countNodesByStatus(runId),
    getRunRow: (runId) => (hidden.has(runId) ? undefined : journal.getRunRow(runId)),
    listRecentLogEvents: (runId, limit) => journal.listRecentLogEvents(runId, limit),
    listRuns: (query) => journal.listRuns(query).filter((row) => !hidden.has(row.runId)),
    // Artifact read faces (the two new DwfRunIntrospectionQueries after migration 0029). These must
    // be forwarded **one by one**, not spread as `...journal`: both journal implementations are
    // classes, a spread copies only own properties, and prototype methods would be lost wholesale.
    // hidden does not participate — this stand-in hides only run rows, and artifacts are fetched by
    // runId, so a hidden run could never fetch its own rows anyway.
    listArtifactRows: (runId) => journal.listArtifactRows(runId),
    countTaggedReports: (runId) => journal.countTaggedReports(runId),
    listArtifactItems: (runId, artifactId, query) =>
      journal.listArtifactItems(runId, artifactId, query),
    listEventPage: (runId, query) => journal.listEventPage(runId, query),
  };
}

describe("dynamic workflow run service — run name 落库", () => {
  // input.name previously lived only on the tool row and the task-title fallback chain, never on
  // dwf_run, so runs enumerated across sessions were just bare runIds. This pins the whole
  // submit → EngineConfig → createRun path.
  it("submit 带 name → dwf_run.name 落库", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      name: "nightly triage",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-name"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.name).toBe("nightly triage");
  });
});

describe("dynamic workflow run service — 内省能力探测", () => {
  // "No runs" and "no capability" must be distinguishable: when the journal lacks the introspection
  // queries, both optional members are **entirely absent**, and the tool layer's typeof probe turns
  // that into a business failure instead of an empty list reading as "this project never ran a workflow".
  it("journal 不带内省查询时两个可选成员缺席", () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    expect(harness.service.listRuns).toBeUndefined();
    expect(harness.service.getRunDetail).toBeUndefined();
  });
});

describe("dynamic workflow run service — listRuns 真相合成", () => {
  it("本会话在飞的 run：running、归本会话、不标 possiblyInterrupted", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        name: "in flight",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-in-flight"),
      });
      await vi.waitFor(() => {
        expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        label: "in flight",
        labelSource: "name",
        ownedByThisSession: true,
        runId,
        status: "running",
      });
      // An in-flight run must never be flagged "possibly interrupted" — the first way a list can lie to the model.
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // A registry hit means ownership, **even if the journal row records another session**. This is
  // exactly the tier possiblyInterrupted must not mislabel: sibling sessions in one process share a
  // sqlite while each keeping its own registry.
  it("注册表命中即归本会话，即使 journal 行记的是别的会话", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: createSessionId("some-other-session"),
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-registry-owned"),
      });
      await vi.waitFor(() => {
        expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({ ownedByThisSession: true, runId, status: "running" });
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // First tier of state precedence: in-memory terminal state > journal state. The in-memory
  // settlement is what this process just took from the engine's hands; the journal row may not be
  // fully written yet (or was modified by something else).
  it("内存终态优先于 journal 状态", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-memory-wins"),
      });
      await settle(harness, runId);
      // Artificially dial the journal row back to non-terminal, creating a split between the two truth sources.
      journal.updateRunStatus(runId, "running");

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({ runId, status: "completed" });
      // Belongs to this session + has an in-memory terminal state ⇒ no such suspicion regardless of what the journal says.
      expect("possiblyInterrupted" in runs[0]!).toBe(false);
    });
  });

  it("他会话的非终态 run 标 possiblyInterrupted 且不归本会话", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-sibling-running",
        status: "running",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({
        ownedByThisSession: false,
        possiblyInterrupted: true,
        runId: "dwfrun-sibling-running",
        status: "running",
      });
      // Annotate only, never rewrite: the journal row must still be running (performing last rites
      // on a sibling session's in-flight run = marking a live run dead; the sole executor of orphan
      // convergence is the owning session's construction moment).
      expect(journal.getRun("dwfrun-sibling-running")?.status).toBe("running");
    });
  });

  it("他会话的终态 run 不标 possiblyInterrupted", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const status of ["completed", "errored", "stopped"] as const) {
        preloadRun(journal, {
          cwd: projectCwd,
          parentSessionId: createSessionId("sibling-session"),
          runId: `dwfrun-sibling-${status}`,
          status,
          ...(status === "stopped" ? { stopReason: "user" as const } : {}),
        });
      }

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(3);
      for (const item of runs) {
        expect(item.ownedByThisSession).toBe(false);
        expect("possiblyInterrupted" in item).toBe(false);
      }
    });
  });

  it("别的项目的 run 不可见（cwd 是字面等值的项目键）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        runId: "dwfrun-here",
        status: "completed",
      });
      preloadRun(journal, {
        cwd: otherCwd,
        runId: "dwfrun-elsewhere",
        status: "completed",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs.map((item) => item.runId)).toEqual(["dwfrun-here"]);
    });
  });

  it("statuses 过滤与 limit 都下推到查询", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const status of ["completed", "errored"] as const) {
        preloadRun(journal, { cwd: projectCwd, runId: `dwfrun-${status}`, status });
      }
      const introspection = introspectionOf(harness);

      const filtered = await introspection.listRuns({
        cwd: projectCwd,
        limit: 20,
        statuses: ["errored"],
      });
      expect(filtered.runs.map((item) => item.runId)).toEqual(["dwfrun-errored"]);

      const limited = await introspection.listRuns({ cwd: projectCwd, limit: 1 });
      expect(limited.runs).toHaveLength(1);
    });
  });

  // truncated's criterion is "fetched one extra" rather than "filled the limit": the latter
  // false-positives when the count exactly equals the limit, sending the model chasing a page of
  // history that does not exist.
  describe("truncated", () => {
    it("为真当且仅当还有 run 没进这一页", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        for (const index of [1, 2, 3]) {
          preloadRun(journal, {
            cwd: projectCwd,
            runId: `dwfrun-page-${index}`,
            status: "completed",
          });
        }
        const introspection = introspectionOf(harness);

        const firstPage = await introspection.listRuns({ cwd: projectCwd, limit: 2 });
        expect(firstPage.runs).toHaveLength(2);
        expect(firstPage.truncated).toBe(true);

        // Count exactly equals the limit: nothing was left out, so the field is entirely absent (not false).
        const exactPage = await introspection.listRuns({ cwd: projectCwd, limit: 3 });
        expect(exactPage.runs).toHaveLength(3);
        expect("truncated" in exactPage).toBe(false);

        const roomyPage = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
        expect("truncated" in roomyPage).toBe(false);
      });
    });

    /**
     * The page at the clamped cap. This looks like a repeat of the previous case but actually pins a
     * coupling testable nowhere else: truncated's decision depends on the storage query accepting
     * "cap + 1". If someone later adds a defensive `Math.min(50, limit)` ceiling inside
     * SqliteDwfJournalStore.listRuns, the probe row gets eaten and truncated is permanently absent
     * at **exactly** limit = 50 — while none of the 2 / 3 / 20 boundary cases fail. The cap comes
     * from the contract constant, so raising the tool-side cap moves this case along automatically.
     */
    it("在钳制上限那一页仍然标 truncated（探测行必须能过存储层）", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        const overflow = LIST_WORKFLOW_RUNS_MAX_LIMIT + 1;
        for (let index = 0; index < overflow; index += 1) {
          preloadRun(journal, {
            cwd: projectCwd,
            runId: `dwfrun-max-${String(index).padStart(3, "0")}`,
            status: "completed",
          });
        }

        const page = await introspectionOf(harness).listRuns({
          cwd: projectCwd,
          limit: LIST_WORKFLOW_RUNS_MAX_LIMIT,
        });
        expect(page.runs).toHaveLength(LIST_WORKFLOW_RUNS_MAX_LIMIT);
        expect(page.truncated).toBe(true);
      });
    });

    it("空项目与被 statuses 过滤空的页都不标 truncated", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-only", status: "completed" });
        const introspection = introspectionOf(harness);

        expect(await introspection.listRuns({ cwd: otherCwd, limit: 20 })).toEqual({ runs: [] });
        expect(
          await introspection.listRuns({ cwd: projectCwd, limit: 20, statuses: ["errored"] }),
        ).toEqual({ runs: [] });
      });
    });

    // The complement also counts as a page: when a gap-run displaces the oldest journal row, the displaced row is exactly "there is more".
    it("注册表补集把 journal 行挤出页时标 truncated", async () => {
      await withSqliteJournal(async (real) => {
        const hidden = new Set<string>();
        const journal = hideRunsFromReads(real, hidden);
        const harness = makeHarness({ hangActors: true, journal });
        preloadRun(real, { cwd: projectCwd, runId: "dwfrun-older", status: "completed" });

        const runId = await submitRun(harness, {
          cwd: projectCwd,
          parentSessionId: HARNESS_PARENT_SESSION,
          scriptText: TYPED_SCRIPT,
          trace: traceFor("gap-truncates"),
        });
        hidden.add(runId);

        const page = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 1 });
        expect(page.runs.map((item) => item.runId)).toEqual([runId]);
        expect(page.truncated).toBe(true);

        await harness.service.cancel(runId);
        await settle(harness, runId);
      });
    });
  });

  it("label 兜底：无 name 的老行取脚本首个非空行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        runId: "dwfrun-unnamed",
        scriptText: "\n  // triage the failing tests\nreturn 1;",
        status: "completed",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({
        label: "// triage the failing tests",
        labelSource: "script",
      });
      // Derived at read time, never written back: persisting it would freeze a display heuristic into data.
      expect("name" in journal.getRun("dwfrun-unnamed")!).toBe(false);
    });
  });

  // Positive assertion of the read-only invariant: not a single write has hit the journal after both read faces.
  it("合成过程不写 journal（写入面零调用、行逐字段不变）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-readonly",
        status: "running",
      });
      const before = journal.getRun("dwfrun-readonly");

      const createRun = vi.spyOn(journal, "createRun");
      const updateRunStatus = vi.spyOn(journal, "updateRunStatus");
      const updateRunUsage = vi.spyOn(journal, "updateRunUsage");
      const appendEvent = vi.spyOn(journal, "appendEvent");
      const putNode = vi.spyOn(journal, "putNode");
      const putActor = vi.spyOn(journal, "putActor");

      const introspection = introspectionOf(harness);
      await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      await introspection.getRunDetail("dwfrun-readonly");

      for (const spy of [
        createRun,
        updateRunStatus,
        updateRunUsage,
        appendEvent,
        putNode,
        putActor,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(journal.getRun("dwfrun-readonly")).toEqual(before);
    });
  });
});

describe("dynamic workflow run service — submit → createRun 的间隙", () => {
  // A run with no journal row yet must appear in the list as pending: without this branch, a run
  // the model just started vanishes from its own project's list (even though it just received the runId).
  it("注册表-only 的 run 以 pending 附加，且排在 journal 行之前", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });
      preloadRun(real, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-already-journaled",
        status: "completed",
      });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        name: "just submitted",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-gap"),
      });
      hidden.add(runId);

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs.map((item) => item.runId)).toEqual([runId, "dwfrun-already-journaled"]);
      expect(runs[0]).toMatchObject({
        label: "just submitted",
        labelSource: "name",
        ownedByThisSession: true,
        spentTokens: 0,
        status: "pending",
      });
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("间隙里的 run 不受 cwd 与 statuses 过滤的豁免", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-gap-filters"),
      });
      hidden.add(runId);
      const introspection = introspectionOf(harness);

      // It must not appear when another project asks (the registry entry carries its own cwd).
      expect((await introspection.listRuns({ cwd: otherCwd, limit: 20 })).runs).toEqual([]);
      // An explicit status filter also governs it — the complement is not an exemption lane from filters.
      expect(
        (await introspection.listRuns({ cwd: projectCwd, limit: 20, statuses: ["completed"] }))
          .runs,
      ).toEqual([]);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // Reporting not_found for a run inside the gap would be a lie: it just handed the runId to the caller.
  it("getRunDetail 对间隙里的 run 回 pending 详情而不是 not_found", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-gap"),
      });
      hidden.add(runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail).toMatchObject({
        actors: [],
        logTail: [],
        ownedByThisSession: true,
        runId,
        status: "pending",
      });
      // Report an honest 0 while the count has no authoritative source yet.
      expect(detail?.usage).toEqual({
        nodesCompleted: 0,
        nodesFailed: 0,
        nodesObserved: 0,
        nodesRunning: 0,
        spentTokens: 0,
      });
      expect("result" in detail!).toBe(false);
      expect("error" in detail!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });
});

describe("dynamic workflow run service — getRunDetail 组合", () => {
  // ── Artifact cross-section (the `GetWorkflowRun` row in docs/dynamic-workflow/authoring.md) ─────────────
  // ⚠ Terminology: artifact = what the script publishes for the **user** to see via `artifact.*`, not
  // the detail's `result` (the script's top-level return value, the engine's internal namesake). The
  // two sit side by side on the same return object, so this must be spelled out.
  //
  // getRunDetail has **two** return branches, both of which must carry artifacts: the journal-row
  // branch (the norm) and the registry-gap branch (run submitted, dwf_run row not yet written).
  // Missing either shows up as "the model cannot see what this run produced", and the gap branch is
  // the easiest to miss — it reads like a pure fallback.
  const DETAIL_ARTIFACT_SCRIPT = [
    'artifact.chart("perf", { x: { field: "round" }, y: { field: "ms" } });',
    'report({ round: 1, ms: 40 }, "perf");',
    'await artifact.markdown("summary", "# 结论");',
    'return "done";',
  ].join("\n");

  /** Text-write-only fake store (the script publishes markdown). */
  function detailArtifactStore(): ToolArtifactStorePort {
    return {
      writeToolResultArtifact: async (request) => ({
        id: "artifact-1",
        uri: "zcode-artifact://harness/artifact-1",
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      }),
      readToolResultArtifact: async () => {
        throw new Error("本用例不读字节");
      },
    };
  }

  it("journal 行分支带 artifacts 截面（看板 + 内容产物，版本与 itemCount 齐全）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ artifactStore: detailArtifactStore(), journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: DETAIL_ARTIFACT_SCRIPT,
        trace: traceFor("detail-artifacts"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.artifacts).toHaveLength(2);
      expect(detail?.artifacts?.[0]).toMatchObject({
        id: "perf",
        kind: "chart",
        version: 1,
        itemCount: 1,
      });
      expect(detail?.artifacts?.[1]).toMatchObject({
        id: "summary",
        kind: "markdown",
        version: 1,
        contentType: "text/markdown",
        itemCount: 0,
      });
      // This is the **same** artifactsOf as the port's listArtifacts, so the two spots are
      // byte-identical — three separate merges would sooner or later diverge on something like
      // "does a failed row count as a version".
      expect(detail?.artifacts).toEqual(await harness.service.listArtifacts!(runId));
    });
  });

  it("间隙分支也带 artifacts：dwf_run 行还没落，节点行却可能已经落了", async () => {
    // The engine can putNode an artifact row immediately after createRun, so "row not yet written"
    // does not mean "nothing produced". This branch reads like a pure fallback and is exactly the
    // one most likely to lose artifacts.
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ artifactStore: detailArtifactStore(), journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: DETAIL_ARTIFACT_SCRIPT,
        trace: traceFor("detail-artifacts-gap"),
      });
      await settle(harness, runId);
      // Hide the dwf_run row: getRunRow returns undefined while the registry entry remains ⇒ the gap branch runs.
      hidden.add(runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      // The gap branch's signature: an honest 0 count, empty actors / logTail.
      expect(detail?.usage).toMatchObject({ nodesObserved: 0, spentTokens: 0 });
      expect(detail?.actors).toEqual([]);
      // But the artifacts are still there.
      expect(detail?.artifacts?.map((entry) => entry.id)).toEqual(["perf", "summary"]);
    });
  });

  it("零产物的 run：两条分支都让 artifacts 整个字段缺席（不是空数组）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-artifacts-none"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail).toBeDefined();
      expect("artifacts" in detail!).toBe(false);
    });
  });

  it("未知 runId 回 undefined（工具层归一成 run_not_found）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      expect(await introspectionOf(harness).getRunDetail("dwfrun-nope")).toBeUndefined();
    });
  });

  it("节点三态计数、nodesObserved 为三者之和、用量直读 journal 行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        spentTokens: 4_321,
        caps: { maxConcurrency: 4 },
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: "dwfrun-counts",
        status: "completed",
      });
      const nodes: { ordinal: number; status: "completed" | "failed" | "running" }[] = [
        { ordinal: 1, status: "completed" },
        { ordinal: 2, status: "completed" },
        { ordinal: 3, status: "failed" },
        { ordinal: 4, status: "running" },
      ];
      for (const node of nodes) {
        journal.putNode({
          runId: "dwfrun-counts",
          siteId: "ask#1",
          ordinal: node.ordinal,
          kind: "ask",
          inputHash: `hash-${node.ordinal}`,
          status: node.status,
        });
      }

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-counts");
      expect(detail?.usage).toEqual({
        nodesCompleted: 2,
        nodesFailed: 1,
        // "Rows of persisted nodes", not "total steps" — a dynamic workflow has no static total.
        nodesObserved: 4,
        nodesRunning: 1,
        spentTokens: 4_321,
      });
    });
  });

  // ── Situational cross-section (docs/dynamic-workflow/launch.md "`GetWorkflowRun`") ────────────────
  // The rules themselves are pinned with hand-crafted events in dynamic-workflow-run-roster.test.ts;
  // this only proves **the wiring works**: real journal events, node rows, and actor rows really get
  // read out and fed into those rules, rather than three empty fields.
  it("journal 行分支带情势截面：子代理的当前 ask 带任务摘要与进度读数，阶段表按声明序", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = "dwfrun-roster-wired";
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId,
        status: "running",
      });
      journal.putActor({ runId, siteId: "agent#1", ordinal: 1, name: "scout" });
      journal.putNode({
        runId,
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        actorSiteId: "agent#1",
        actorOrdinal: 1,
        actorSeq: 1,
        inputHash: "hash-ask-1",
        status: "running",
      });
      for (const event of [
        { type: "run-started", runId, caps: { maxConcurrency: 4 } },
        { type: "run-launched", inputId: "in-wired", phaseNames: ["collect", "verify"] },
        { type: "phase-entered", name: "collect", ordinal: 1 },
        { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "scout" },
        {
          type: "node-queued",
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "agent#1", ordinal: 1 },
          actorSeq: 1,
          phaseName: "collect",
          instructionsHead: "Collect every regression named in the release notes.",
        },
        { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } },
        { type: "node-executing", instance: { siteId: "ask#1", ordinal: 1 } },
        {
          type: "node-progress",
          instance: { siteId: "ask#1", ordinal: 1 },
          turn: 2,
          toolCalls: 7,
          lastTool: { name: "Read", target: "docs/release.md" },
        },
      ] as RunEvent[]) {
        journal.appendEvent(runId, event);
      }

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.subagents).toHaveLength(1);
      expect(detail?.subagents[0]).toMatchObject({
        siteId: "agent#1",
        name: "scout",
        state: "executing",
        phaseName: "collect",
        currentAsk: {
          siteId: "ask#1",
          ordinal: 1,
          actorSeq: 1,
          instructionsHead: "Collect every regression named in the release notes.",
          turn: 2,
          toolCalls: 7,
          lastTool: { name: "Read", target: "docs/release.md" },
        },
      });
      // The moment comes from dwf_event.time_created, so on a real database it must be a real millisecond value.
      expect(detail?.subagents[0]?.currentAsk?.startedAt).toBeGreaterThan(0);
      expect(detail?.phases).toMatchObject([
        { name: "collect", state: "current", rounds: 1, nodesRunning: 1 },
        { name: "verify", state: "ahead", rounds: 0 },
      ]);
      // The row names this session as originator, but the session's registry has no entry — a
      // post-restart leftover: the in-process parked-question table died with the previous process,
      // so this read **cannot answer** whether a question is waiting; it can only say honestly "unknown".
      expect(detail?.ownedByThisSession).toBe(true);
      expect(detail?.health).toMatchObject({
        consecutiveFailures: 0,
        cachedSteps: 0,
        pendingQuestionsKnown: false,
      });
    });
  });

  it("终态 run：pendingQuestionsKnown 为真（没有人还在听），遗留的 running 行被数出来", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = "dwfrun-roster-terminal";
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId,
        status: "stopped",
        stopReason: "interrupted",
      });
      journal.putActor({ runId, siteId: "agent#1", ordinal: 1, name: "worker" });
      journal.putNode({
        runId,
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        actorSiteId: "agent#1",
        actorOrdinal: 1,
        actorSeq: 1,
        inputHash: "hash-ask-1",
        status: "running",
      });
      for (const event of [
        { type: "run-started", runId, caps: { maxConcurrency: 4 } },
        { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "worker" },
        {
          type: "node-queued",
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "agent#1", ordinal: 1 },
          actorSeq: 1,
        },
        { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } },
      ] as RunEvent[]) {
        journal.appendEvent(runId, event);
      }

      const detail = await introspectionOf(harness).getRunDetail(runId);
      // A terminal run by definition has no one still listening, so "no pending questions" is a definite statement.
      expect(detail?.health).toMatchObject({ pendingQuestionsKnown: true, leftoverRunning: 1 });
      expect(detail?.subagents[0]).toMatchObject({ name: "worker", state: "unfinished" });
      // The script has no phase() markers and never entered a phase ⇒ the field is entirely absent.
      expect("phases" in detail!).toBe(false);
    });
  });

  it("actors 全列出（siteId / ordinal / name），persona 不出", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-actors", status: "completed" });
      journal.putActor({
        runId: "dwfrun-actors",
        siteId: "actor#1",
        ordinal: 1,
        name: "worker",
        persona: { system: "a very long system prompt" },
      });
      journal.putActor({ runId: "dwfrun-actors", siteId: "actor#2", ordinal: 3 });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-actors");
      expect(detail?.actors).toEqual([
        { siteId: "actor#1", ordinal: 1, name: "worker" },
        { siteId: "actor#2", ordinal: 3 },
      ]);
    });
  });

  it("logTail：只取 log 事件、末 20 条、按时序、逐条 2048 字符界", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-logs", status: "completed" });
      journal.appendEvent("dwfrun-logs", {
        caps: { maxConcurrency: 4 },
        runId: "dwfrun-logs",
        type: "run-started",
      });
      for (let index = 1; index <= 25; index += 1) {
        journal.appendEvent("dwfrun-logs", { message: `step ${index}`, type: "log" });
      }
      const overlong = "x".repeat(5_000);
      journal.appendEvent("dwfrun-logs", { message: overlong, type: "log" });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-logs");
      const logTail = detail!.logTail;
      expect(logTail).toHaveLength(20);
      // Chronological (sequence ascending), with the tail being the **last** 20: the earliest kept is step 7.
      expect(logTail.map((entry) => entry.sequence)).toEqual(
        [...logTail].sort((left, right) => left.sequence - right.sequence).map((e) => e.sequence),
      );
      expect(logTail[0]?.message).toBe("step 7");
      expect(logTail.at(-1)?.message).toHaveLength(
        DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
      );
      // run-started is not a log entry: type filtering is pushed down to SQL and cannot sneak in on "the model can't read it anyway".
      expect(logTail.some((entry) => entry.message.includes("run-started"))).toBe(false);
      // Each narrative carries its own persistence moment (dwf_event.time_created): the read face
      // computes "how long ago" from it, instead of using read-time Date.now() and stamping
      // week-old history as "just now".
      for (const entry of logTail) {
        expect(typeof entry.at).toBe("number");
        expect(entry.at).toBeLessThanOrEqual(Date.now());
      }
    });
  });

  it("没有 log 事件时 logTail 是空数组", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-nologs", status: "completed" });

      expect((await introspectionOf(harness).getRunDetail("dwfrun-nologs"))?.logTail).toEqual([]);
    });
  });

  // Timestamps read the journal row directly, deliberately bypassing the snapshot face's new Date(0)
  // fallback: after the in-memory entry evaporates that start time is fake, and the model judges
  // "how old is this run" from it.
  it("createdAt / updatedAt 来自 journal 行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const before = Date.now();
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-times", status: "running" });
      journal.updateRunStatus("dwfrun-times", "completed");
      const after = Date.now();

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-times");
      expect(detail!.createdAt).toBeGreaterThanOrEqual(before);
      expect(detail!.updatedAt).toBeGreaterThanOrEqual(detail!.createdAt);
      expect(detail!.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  it("running 的 run 既无 result 也无 error", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-running",
        status: "running",
      });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-running");
      expect("result" in detail!).toBe(false);
      expect("error" in detail!).toBe(false);
    });
  });

  it("completed：内存终态的产物原样交出（不序列化）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "the answer" } }] },
        journal,
      });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-result-memory"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.status).toBe("completed");
      // The original value, not JSON text: model-facing serialization has a single implementation in
      // core (shared by the completion notification and TaskOutput); the port doing it again would
      // produce "one artifact, two faces".
      expect(detail?.result).toBe("the answer");
      expect("error" in detail!).toBe(false);
    });
  });

  it("completed：注册表蒸发后退回 journal 的 result_json", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-result-json", status: "running" });
      journal.updateRunStatus("dwfrun-result-json", "completed", {
        result: { report: "final answer", steps: 3 },
      });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-result-json");
      expect(detail?.result).toEqual({ report: "final answer", steps: 3 });
    });
  });

  it("completed 但产物是 undefined → result 整字段缺席", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-void", status: "completed" });

      expect("result" in (await introspectionOf(harness).getRunDetail("dwfrun-void"))!).toBe(false);
    });
  });

  // The model must be able to tell "the process died" (Interrupted) from "the script genuinely
  // failed" (DriverError): the code passes through verbatim, never folded into one generic failure.
  it("errored / stopped(interrupted)：failure_json 的 code 原样透出（含 Interrupted）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const code of ["Interrupted", "DriverError"] as const) {
        preloadRun(journal, {
          cwd: projectCwd,
          failure: { code, message: `failed with ${code}` },
          runId: `dwfrun-failed-${code}`,
          ...(code === "Interrupted"
            ? { status: "stopped" as const, stopReason: "interrupted" as const }
            : { status: "errored" as const }),
        });
      }
      const introspection = introspectionOf(harness);

      expect((await introspection.getRunDetail("dwfrun-failed-Interrupted"))?.error).toEqual({
        code: "Interrupted",
        message: "failed with Interrupted",
      });
      expect((await introspection.getRunDetail("dwfrun-failed-DriverError"))?.error).toEqual({
        code: "DriverError",
        message: "failed with DriverError",
      });
    });
  });

  it("cancelled：带 error（失败编码在场时）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        failure: { code: "Cancelled", message: "cancelled by user" },
        runId: "dwfrun-cancelled",
        status: "stopped",
        stopReason: "user",
      });

      expect((await introspectionOf(harness).getRunDetail("dwfrun-cancelled"))?.error).toEqual({
        code: "Cancelled",
        message: "cancelled by user",
      });
    });
  });
});

describe("resolveDynamicWorkflowJournalStore", () => {
  // No service without a journal: a run silently losing its persistence is worse than no run.
  it("store 缺少 workflowJournalStore 时返回 undefined 并记原因", () => {
    const messages: string[] = [];
    const resolved = resolveDynamicWorkflowJournalStore(
      {} as never,
      {
        info: (message: string) => {
          messages.push(message);
        },
      } as never,
    );

    expect(resolved).toBeUndefined();
    expect(messages.join(" ")).toContain("dwf journal");
  });

  it("store 提供 workflowJournalStore 时透出该 journal", () => {
    const journal = new InMemoryJournalStore();
    const resolved = resolveDynamicWorkflowJournalStore({
      workflowJournalStore: () => journal,
    } as never);

    expect(resolved).toBe(journal);
  });
});

describe("dynamic workflow run service — resume", () => {
  const TWO_ASK_SCRIPT = [
    "interface Answer { text: string }",
    'const worker = agent("worker");',
    'const first = await worker.ask<Answer>("step one");',
    "const second = await worker.ask(`step two after ${first.text}`);",
    "return `${first.text}+${second}`;",
  ].join("\n");

  const RESUME_TOOL_CALL = createToolCallId("resume-origin");

  /**
   * Phase one: run a run to "ask#1 completed, ask#2 in flight", then cancel.
   * The journal keeps: the actor (with session id), completed ask#1, running ask#2 — exactly the
   * shape resume must take over. The options object is held by the makeHarness closure, so tests
   * can rewrite actorScripts between the phases (the phase-two fresh runtime reads the scripts at
   * then-current values).
   */
  async function cancelledMidFlight(options: HarnessOptions = {}) {
    options.actorScripts = {
      "actor#1@1": [{ kind: "submit", result: { text: "one" } }, { kind: "hang" }],
    };
    const harness = makeHarness(options);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TWO_ASK_SCRIPT,
      toolCallId: RESUME_TOOL_CALL,
      trace: traceFor("resume-phase1"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runId, "ask#2", 1)?.status).toBe("running");
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
    expect(harness.journal.getNode(runId, "ask#1", 1)?.status).toBe("completed");
    expect(harness.journal.getActor(runId, "actor#1", 1)?.sessionId).toBeDefined();
    return { harness, runId };
  }

  it("恢复被取消的 run：完结节点短路、在飞节点重派发、run 跑到 completed", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);
    const linksAfterPhaseOne = harness.taskLinks.length;
    const persistsAfterPhaseOne = harness.persistedTitles.length;

    // Phase-two script: the fresh runtime only needs to answer the re-dispatched ask#2 (untyped → some text).
    options.actorScripts = { "actor#1@1": [{ kind: "text", text: "two" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true, runId, toolCallId: RESUME_TOOL_CALL });

    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("one+two");
    expect(harness.journal.getRun(runId)?.status).toBe("completed");

    // ask#1 was not re-run: 3 model requests across both phases (submit + hang + phase-two text);
    // re-dispatching ask#1 would make it 4. The actor runtime is constructed once per phase.
    expect(harness.order.filter((entry) => entry.startsWith("turn:")).length).toBe(3);
    expect(harness.order.filter((entry) => entry.startsWith("construct:")).length).toBe(2);
    // Rehydration: the journaled actor re-attaches via resumeFromStore; the session row and task link are not rebuilt.
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.taskLinks.length).toBe(linksAfterPhaseOne);
    expect(harness.persistedTitles.length).toBe(persistsAfterPhaseOne);

    // Event face: sequence continues monotonically across both phases; run-started appears twice; ask#1 settles short-circuited as cached.
    const sequences = harness.runEvents.map((event) => event.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    expect(harness.runEvents.filter((event) => event.eventType === "run-started")).toHaveLength(2);
    const cachedSettles = harness.runEvents.filter(
      (event) =>
        event.eventType === "node-settled" &&
        (event.payload as { cached?: boolean }).cached === true,
    );
    expect(cachedSettles.length).toBeGreaterThanOrEqual(1);
  });

  it("恢复后 cancel 依然可用（注册表条目被替换成新的 AbortController）", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);

    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true });

    // Wait until the re-dispatched ask#2 is truly in flight (phase two's 3rd model request).
    await vi.waitFor(() => {
      expect(harness.order.filter((entry) => entry.startsWith("turn:")).length).toBe(3);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
  });

  it("resume 返回后 getTask 立即报 running（journal 状态已翻回）", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);

    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    await harness.service.resume?.(runId);
    // No waiting for settlement: launch's synchronous prefix already walked engine construction through the resume branch (updateRunStatus running).
    expect((await harness.service.getTask(runId))?.status).toBe("running");

    await harness.service.cancel(runId);
    await settle(harness, runId);
  });

  it("孤儿收敛出的 stopped(interrupted) run 可恢复，且恢复清掉陈旧 failure", async () => {
    const { createHash } = await import("node:crypto");
    const journal = new SweepableJournalStore();
    const runId = "dwfrun-interrupted";
    journal.createRun({
      runId,
      parentSessionId: HARNESS_PARENT_SESSION,
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptHash: createHash("sha256").update(TYPED_SCRIPT, "utf8").digest("hex"),
      toolCallId: "call-interrupted",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const harness = makeHarness({
      journal,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revived" } }] },
    });
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true, runId, toolCallId: "call-interrupted" });

    await settle(harness, runId);
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("completed");
    // The non-terminal flip cleared the Interrupted residue (updateRunStatus's new semantics via the real path).
    expect(record?.failure).toBeUndefined();
    expect(record?.stopReason).toBeUndefined();
    expect((await harness.service.getTask(runId))?.output).toBe("revived");
    // Empty journal (no actor records) → the fresh persistence path, no rehydration.
    expect(harness.resumeCalls).toHaveLength(0);
    expect(harness.persistedTitles).toHaveLength(1);
  });

  it("回退：resumeFromStore 抛 SessionNotFound 时退回全新持久化路径", async () => {
    const options: HarnessOptions = { resumeSessionMissing: true };
    const { harness, runId } = await cancelledMidFlight(options);
    const persistsAfterPhaseOne = harness.persistedTitles.length;

    options.actorScripts = { "actor#1@1": [{ kind: "text", text: "two" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true });

    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    // Rehydration was attempted (journaled actor) and fell back after failure: the session was persisted anew.
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.persistedTitles.length).toBe(persistsAfterPhaseOne + 1);
    // The fallback leaves a trace (warn), not silence.
    expect(
      harness.logs.some(
        (log) =>
          log.level === "warn" &&
          log.context?.event === "dynamic_workflow.actor.rehydrate_fallback",
      ),
    ).toBe(true);
  });
});

/**
 * Argument persistence and replay (docs/dynamic-workflow/launch.md "Running a saved workflow").
 *
 * This group guards one sentence: **resume replays the stored arguments and never accepts new
 * ones**. The failure shape is quiet — a recovered run re-runs with `{}`, the script walks into a
 * different branch, and nothing shows on the run panel.
 */
describe("dynamic workflow run service — run args", () => {
  // Carry the arguments in the artifact: "did the arguments reach the sandbox" becomes a fact
  // visible directly from getTask, not something to infer from indirect counts.
  const ARGS_SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>(`work on ${String(args.target)}`);',
    "return `${String(args.target)}:${a.text}`;",
  ].join("\n");

  it("落库 submit 收到的实参，并把它注入沙箱", async () => {
    const harness = makeHarness({
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "done" } }] },
    });

    const runId = await submitRun(harness, {
      args: { target: "packages/core" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-submit"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.args).toEqual({ target: "packages/core" });
    // Persisting is only half: the artifact proves these arguments really reached the sandbox and were read by the script.
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("packages/core:done");
  });

  it("resume 重放持久化的实参，且 resume 入口根本收不下新实参", async () => {
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    };
    const harness = makeHarness(options);
    const runId = await submitRun(harness, {
      args: { target: "original-target" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runId, "ask#1", 1)?.status).toBe("running");
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "resumed" } }] };
    // resume's signature takes only a runId: swapping arguments is **inexpressible** on this entry,
    // and that is the design — new arguments = a new run = a new confirmation dialog.
    expect(await harness.service.resume?.(runId)).toMatchObject({ ok: true, runId });
    await settle(harness, runId);

    // The recovered run still uses the approved arguments, and the record was not rewritten by resume.
    expect(harness.journal.getRun(runId)?.args).toEqual({ target: "original-target" });
    const resumed = await harness.service.getTask(runId);
    expect(resumed?.status).toBe("completed");
    // The artifact's arguments are the **first approved** set: resume replays them, it does not re-collect.
    expect(resumed?.output).toBe("original-target:resumed");
  });

  // The GUI "Configure" re-runs the predecessor's own script (docs/dynamic-workflow/launch.md
  // "Changing a run's settings from the GUI"): `inheritArgs` lets an amendment carry over the
  // predecessor's persisted arguments; the tool path does not pass it, so amendments stay argument-less.
  it("amend 默认不带实参；inheritArgs 沿用前驱落库的那一份并注入沙箱", async () => {
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    };
    const harness = makeHarness(options);
    const runA = await submitRun(harness, {
      args: { target: "packages/core" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-a"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runA, "ask#1", 1)?.status).toBe("running");
    });

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "kept" } }] };
    const inherited = await amendRun(harness, {
      cwd: TEST_CWD,
      inheritArgs: true,
      parentSessionId: HARNESS_PARENT_SESSION,
      predecessorRunId: runA,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-b"),
    });
    await settle(harness, inherited.runId);
    expect(harness.journal.getRun(inherited.runId)?.args).toEqual({ target: "packages/core" });
    expect((await harness.service.getTask(inherited.runId))?.output).toBe("packages/core:kept");

    // Tool path (no inheritArgs): amend once more from the same predecessor; the new run carries no
    // arguments. The hung predecessor has no completed ask, so the boundary precheck passes naturally.
    const plain = await amendRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      predecessorRunId: runA,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-c"),
    });
    await settle(harness, plain.runId);
    expect(harness.journal.getRun(plain.runId)?.args).toBeUndefined();
  });
});

describe("dynamic workflow run service — resume 门", () => {
  it("未知 runId → not_found", async () => {
    const harness = makeHarness();
    await expect(harness.service.resume?.("dwfrun-nope")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("completed run → not_resumable", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("gate-completed"),
    });
    await settle(harness, runId);
    await expect(harness.service.resume?.(runId)).resolves.toEqual({
      ok: false,
      reason: "not_resumable",
    });
  });

  it("errored → not_resumable（脚本真失败 replay 只会逐字复现）", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-script-failed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-script-failed")).resolves.toEqual({
      ok: false,
      reason: "not_resumable",
    });
  });

  it("记录缺 scriptText → script_missing", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-old",
      parentSessionId: HARNESS_PARENT_SESSION,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-old")).resolves.toEqual({
      ok: false,
      reason: "script_missing",
    });
  });

  it("scriptHash 与原文不自洽 → script_mismatch，journal 状态不被触碰", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-tampered",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      scriptHash: "bogus-hash",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-tampered")).resolves.toEqual({
      ok: false,
      reason: "script_mismatch",
    });
    // Rejection creates no registry entry and starts no engine: the record stays stopped and can still be recovered after fixing.
    expect(harness.journal.getRun("dwfrun-tampered")?.status).toBe("stopped");
  });

    // A pre-facade-refactor run (2026-09-15): the original text was written against the then-current facade and no longer type-checks.
  it("原文在当前 facade 下编不过 → compile_failed 携有界诊断，journal 状态不被触碰", async () => {
    const journal = new SweepableJournalStore();
    const legacyScript =
      "const planner = agent('planner');\nawait planner.askWithOldFacade('x');\n";
    journal.createRun({
      runId: "dwfrun-legacy-facade",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: legacyScript,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "interrupted",
    });
    const harness = makeHarness({ journal });
    const result = await harness.service.resume?.("dwfrun-legacy-facade");
    expect(result).toMatchObject({ ok: false, reason: "compile_failed" });
    expect((result as { message?: string }).message).toMatch(/no longer compiles/);
    expect((result as { message?: string }).message).toMatch(/L\d+:C\d+/);
    expect(harness.journal.getRun("dwfrun-legacy-facade")?.status).toBe("stopped");
  });

  it("同 runId 在飞 → already_running", async () => {
    const harness = makeHarness({
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("gate-inflight"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    await expect(harness.service.resume?.(runId)).resolves.toEqual({
      ok: false,
      reason: "already_running",
    });
    await harness.service.cancel(runId);
    await settle(harness, runId);
  });
});

// Cold replay (docs/dynamic-workflow/presentation.md): journal → the same kind of progress payload as live.
// "Consistent across restart" becomes assertable here: finish a run on one sqlite journal; the payload
// sequence live onRunEvent delivered is byte-identical to the replay sequence of a **new** service
// instance (empty registry = restart); the workflowRuns the shared reducer derives from the two are
// naturally equal too.
describe("dynamic workflow run service — replayProgressForSession（冷回放）", () => {
  const REPLAY_SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>("do the thing");',
    'await artifact.markdown("summary", a.text);',
    "return a.text;",
  ].join("\n");

  /** Minimal artifact store: just enough for `artifact.markdown` to publish (read faces are out of this group's scope). */
  function artifactStore(): ToolArtifactStorePort {
    let next = 0;
    return {
      writeToolResultArtifact: async (request) => {
        next += 1;
        return {
          id: `artifact-${next}`,
          uri: `zcode-artifact://replay/artifact-${next}`,
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: request.contentType ?? "text/plain",
          createdAt: new Date(0),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not read in replay tests");
      },
      readToolResultBinaryArtifact: async () => {
        throw new Error("not read in replay tests");
      },
    };
  }

  function reduceAll(payloads: readonly DynamicWorkflowRunProgressPayload[]) {
    let state: WorkflowRunsState | undefined;
    for (const payload of payloads) {
      state = reduceWorkflowRunsState(state, payload as WorkflowRunProgressEnvelope) ?? state;
    }
    return state;
  }

  it("跑完一个 run 后，新实例的回放载荷与 live 载荷逐字节相等，归约态深等且过 strict schema", async () => {
    await withSqliteJournal(async (journal) => {
      const live = makeHarness({ artifactStore: artifactStore(), journal });
      const toolCallId = createToolCallId("call-replay");
      const runId = await submitRun(live, {
        cwd: projectCwd,
        name: "replay me",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: REPLAY_SCRIPT,
        toolCallId,
        trace: traceFor("replay-live"),
      });
      await settle(live, runId);
      expect(journal.getRun(runId)?.status).toBe("completed");
      // Something to compare: actors, nodes, usage, artifacts, and settle are all on this run.
      const kinds = new Set(live.runEvents.map((event) => event.eventType));
      for (const kind of [
        "run-started",
        "actor-created",
        "node-settled",
        "usage-updated",
        "artifact-published",
        "run-settled",
      ]) {
        expect(kinds.has(kind)).toBe(true);
      }

      // "Restart" = build another service on the same journal: empty registry, no events in memory.
      const cold = makeHarness({ artifactStore: artifactStore(), journal });
      const replayed = await cold.service.replayProgressForSession!({ excludeRunIds: new Set() });

      expect(replayed).toEqual(live.runEvents);
      // Host-derived fields must also match on both sides: `concurrencyCeiling` lives only in the
      // payload (the engine does not know the machine's core count), and cold replay missing one key
      // is a silent projection fork — the equality assertion above is its guardrail, and this pins
      // "it is present and equals default concurrency" separately so both sides going absent cannot
      // still pass the equality.
      const startedCeiling = (event: DynamicWorkflowRunProgressPayload | undefined) =>
        (event?.payload as { concurrencyCeiling?: number } | undefined)?.concurrencyCeiling;
      const liveStarted = live.runEvents.find((event) => event.eventType === "run-started");
      const coldStarted = replayed.find((event) => event.eventType === "run-started");
      expect(startedCeiling(liveStarted)).toBe(resolveWorkflowDefaultConcurrency());
      expect(startedCeiling(coldStarted)).toBe(startedCeiling(liveStarted));
      const liveState = reduceAll(live.runEvents);
      const coldState = reduceAll(replayed);
      expect(coldState).toEqual(liveState);
      expect(coldState?.runs[0]).toMatchObject({
        runId,
        status: "completed",
        toolCallId: String(toolCallId),
      });
      expect(coldState?.runs[0]?.actors.length).toBeGreaterThan(0);
      expect(coldState?.runs[0]?.nodes.length).toBeGreaterThan(0);
      expect(coldState?.runs[0]?.usage.spentTokens).toBeGreaterThan(0);
      expect(workflowRunsStateSchema.parse(coldState)).toEqual(coldState);
    });
  });

  it("被打断的 run（行 stopped/interrupted、事件流没有 run-settled）：追加内存态合成 settle，携 resumable；journal 不动", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-interrupted",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "running",
    });
    journal.appendEvent("dwfrun-interrupted", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "actor-created",
      actor: { siteId: "actor#1", ordinal: 1 },
      name: "worker",
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "node-queued",
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "escalation-raised",
      qid: "dwfq-1",
      actor: { siteId: "actor#1", ordinal: 1 },
      question: "which branch?",
      askedAt: 1,
    } as never);
    const before = journal.listEvents("dwfrun-interrupted", {
      types: "all",
      reportItems: "all",
    }).length;

    // Construction is itself orphan convergence: the row is rewritten to stopped/interrupted, the event stream untouched (the converger synthesizes no events).
    const harness = makeHarness({ journal });
    expect(journal.getRun("dwfrun-interrupted")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted" },
    });
    const replayed = await harness.service.replayProgressForSession!({ excludeRunIds: new Set() });

    expect(
      journal.listEvents("dwfrun-interrupted", { types: "all", reportItems: "all" }),
    ).toHaveLength(before);
    const last = replayed.at(-1);
    expect(last).toMatchObject({
      runId: "dwfrun-interrupted",
      sequence: before,
      eventType: "run-settled",
      payload: {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted" },
        resumable: true,
      },
    });
    expect(replayed.filter((event) => event.eventType === "run-settled")).toHaveLength(1);
    const state = reduceAll(replayed);
    expect(state?.runs[0]).toMatchObject({ status: "stopped", resumable: true });
    expect(state?.runs[0]?.error).toContain("exited");
    // Parked questions clear with the terminal state: after the process dies, nobody is waiting for answers.
    expect(state?.runs[0]?.pendingQuestions).toBeUndefined();
    expect(state?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("cancelled 行同样携 resumable；行终态且事件流已含 run-settled 时不再合成第二条", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-cancelled",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "user",
    });
    journal.appendEvent("dwfrun-cancelled", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);
    journal.appendEvent("dwfrun-cancelled", {
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    } as never);
    preloadRun(journal, {
      runId: "dwfrun-crashed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    journal.appendEvent("dwfrun-crashed", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);

    const harness = makeHarness({ journal });
    const replayed = await harness.service.replayProgressForSession!({ excludeRunIds: new Set() });
    const byRun = new Map<string, DynamicWorkflowRunProgressPayload[]>();
    for (const event of replayed) {
      byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
    }
    // Settle already included: exactly one, with resumable backfilled from the row predicate (an old journal's settle event lacks that bit).
    const cancelled = byRun.get("dwfrun-cancelled") ?? [];
    expect(cancelled.filter((event) => event.eventType === "run-settled")).toHaveLength(1);
    expect(cancelled.at(-1)?.payload).toMatchObject({
      status: "stopped",
      stopReason: "user",
      resumable: true,
    });
    // Genuine script failure: the synthesized settle carries no resumable.
    const crashed = byRun.get("dwfrun-crashed") ?? [];
    expect(crashed.at(-1)?.payload).toEqual({
      status: "errored",
      error: { code: "DriverError", message: "script threw" },
    });
  });

  it("排除集：内存里已有的 runId 与注册表在飞的 run 不回放；兄弟会话的 run 不进；上界 8 且最旧优先", async () => {
    const journal = new SweepableJournalStore();
    for (let index = 1; index <= 10; index += 1) {
      preloadRun(journal, {
        runId: `dwfrun-old-${index}`,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        status: "completed",
      });
      journal.appendEvent(`dwfrun-old-${index}`, {
        type: "run-started",
        caps: { maxConcurrency: 4 },
      } as never);
      journal.appendEvent(`dwfrun-old-${index}`, {
        type: "run-settled",
        status: "completed",
      } as never);
    }
    preloadRun(journal, {
      runId: "dwfrun-sibling",
      parentSessionId: "ses_other",
      scriptText: TYPED_SCRIPT,
      status: "completed",
    });
    journal.appendEvent("dwfrun-sibling", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);

    const harness = makeHarness({ hangActors: true, journal });
    const inFlight = await submitRun(harness, {
      cwd: projectCwd,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("replay-in-flight"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    const replayed = await harness.service.replayProgressForSession!({
      excludeRunIds: new Set(["dwfrun-old-10"]),
    });
    const order: string[] = [];
    for (const event of replayed) {
      if (order.at(-1) !== event.runId) order.push(event.runId);
    }
    // The enumeration face yields the most recent 8 (of old-3..old-10 plus the in-flight one), replaying
    // oldest first; the in-flight and excluded ones are absent, sibling sessions' even more so.
    expect(order).not.toContain(inFlight);
    expect(order).not.toContain("dwfrun-old-10");
    expect(order).not.toContain("dwfrun-sibling");
    expect(order).toEqual([
      "dwfrun-old-4",
      "dwfrun-old-5",
      "dwfrun-old-6",
      "dwfrun-old-7",
      "dwfrun-old-8",
      "dwfrun-old-9",
    ]);

    expect(await harness.service.cancel(inFlight)).toBe(true);
    await settle(harness, inFlight);
  });

  it("内存 journal（无枚举面）：回放回空", async () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    await expect(
      harness.service.replayProgressForSession!({ excludeRunIds: new Set() }),
    ).resolves.toEqual([]);
  });
});

describe("dynamic workflow run service — listRunsForSession", () => {
  it("回本会话的 run 摘要，resumable 与 resume 门同源", async () => {
    const journal = new SweepableJournalStore();
    const seed = (input: {
      runId: string;
      status: RunStatus;
      failure?: { code: string; message: string };
      stopReason?: RunStopReason;
      toolCallId?: string;
      parentSessionId?: string;
    }): void => {
      journal.createRun({
        runId: input.runId,
        parentSessionId: input.parentSessionId ?? HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        caps: { maxConcurrency: 4 },
        spentTokens: 0,
        status: input.status,
        ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
        ...(input.failure === undefined ? {} : { failure: input.failure as never }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      });
    };
    seed({ runId: "dwfrun-done", status: "completed", toolCallId: "call-done" });
    seed({
      runId: "dwfrun-stopped",
      status: "stopped",
      stopReason: "user",
      toolCallId: "call-stopped",
    });
    seed({
      runId: "dwfrun-interrupted",
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });
    seed({
      runId: "dwfrun-crashed",
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    seed({
      runId: "dwfrun-other",
      status: "stopped",
      stopReason: "user",
      parentSessionId: "ses_other",
    });

    const harness = makeHarness({ journal });
    const summaries = await harness.service.listRunsForSession?.();

    expect(summaries?.map((summary) => summary.runId).sort()).toEqual([
      "dwfrun-crashed",
      "dwfrun-done",
      "dwfrun-interrupted",
      "dwfrun-stopped",
    ]);
    const byId = new Map(summaries?.map((summary) => [summary.runId, summary]));
    expect(byId.get("dwfrun-stopped")).toMatchObject({
      resumable: true,
      status: "stopped",
      stopReason: "user",
      toolCallId: "call-stopped",
    });
    expect(byId.get("dwfrun-interrupted")).toMatchObject({
      failureCode: "Interrupted",
      resumable: true,
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(byId.get("dwfrun-done")).toMatchObject({ resumable: false, status: "completed" });
    expect(byId.get("dwfrun-crashed")).toMatchObject({
      failureCode: "DriverError",
      resumable: false,
    });
  });

  it("journal 无枚举能力（内存实现）时回空列表而不是抛错", async () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    await expect(harness.service.listRunsForSession?.()).resolves.toEqual([]);
  });

  // The label shares resolveDynamicWorkflowRunLabel with the tool face: if the enumeration face
  // hand-assembled its own fallback, one run would show two names across /dwf list and the tool
  // card (docs/dynamic-workflow/launch.md "`/dwf`").
  it("label 走 name → 脚本首行 → runId 的同一条派生链", async () => {
    const journal = new SweepableJournalStore();
    const seed = (input: { runId: string; name?: string; scriptText?: string }): void => {
      journal.createRun({
        runId: input.runId,
        parentSessionId: HARNESS_PARENT_SESSION,
        ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
        ...(input.name === undefined ? {} : { name: input.name }),
        caps: { maxConcurrency: 4 },
        spentTokens: 0,
        status: "completed",
      });
    };
    seed({ runId: "dwfrun-named", name: "nightly audit", scriptText: TYPED_SCRIPT });
    seed({ runId: "dwfrun-unnamed", scriptText: TYPED_SCRIPT });
    // A whitespace-only name equals no name — otherwise the list shows an unclickable blank row.
    seed({ runId: "dwfrun-blank", name: "   ", scriptText: TYPED_SCRIPT });
    seed({ runId: "dwfrun-bare" });

    const harness = makeHarness({ journal });
    const byId = new Map(
      (await harness.service.listRunsForSession?.())?.map((summary) => [summary.runId, summary]),
    );

    expect(byId.get("dwfrun-named")?.label).toBe("nightly audit");
    expect(byId.get("dwfrun-unnamed")?.label).toBe("interface Answer { text: string }");
    expect(byId.get("dwfrun-blank")?.label).toBe("interface Answer { text: string }");
    expect(byId.get("dwfrun-bare")?.label).toBe("dwfrun-bare");
  });

  // updatedAt reads the journal row's time_updated directly: `RunRecord` carries no time, so the
  // enumeration face must use the narrow projection's row type (DwfRunSessionListItem) — falling
  // back to RunRecord would silently turn this field undefined.
  it("updatedAt 透传 journal 行的 time_updated", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-timed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "completed",
    });

    const harness = makeHarness({ journal });
    const [summary] = (await harness.service.listRunsForSession?.()) ?? [];

    expect(summary?.updatedAt).toBe(journal.rowTimeOf("dwfrun-timed"));
  });

  // failure must survive the narrow projection: the model face reports failureCode / failureMessage
  // ("the process died" as a second piece of evidence via the Interrupted code), and resumable is
  // decided by status === "stopped".
  it("窄投影仍带 failure，stopped(interrupted) 判可恢复", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "interrupted",
    });

    const harness = makeHarness({ journal });
    const [summary] = (await harness.service.listRunsForSession?.()) ?? [];

    expect(summary).toMatchObject({
      failureCode: "Interrupted",
      failureMessage: "owning process exited",
      resumable: true,
      status: "stopped",
      stopReason: "interrupted",
    });
  });
});

// ————————————————————————————————————————————————————————————————
// amend-resume: apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
// ————————————————————————————————————————————————————————————————

/**
 * A script with one named actor asking twice + one world-read; the `tail` parameter changes the
 * **second question's** body, so seq 0 always hits and seq 1 always diverges — exactly the shape
 * "prefix hits / live from the divergence point" needs to observe.
 */
function amendScript(tail: string): string {
  return [
    "interface Answer { text: string }",
    'const w = agent("worker");',
    'const paths = await files.glob("src/**/*.ts");',
    'const first = await w.ask<Answer>("first question");',
    `const last = await w.ask<Answer>(${JSON.stringify(tail)});`,
    "return `${first.text}|${last.text}|${paths.length}`;",
  ].join("\n");
}

/**
 * 两个具名 actor 各问一次：崩溃后重建用例靠它把「未消费的导入」留在 beta 上。
 *
 * 追记 2026-09-12：persona 不再声明工具档位，所以任一 ask 分歧转 live 都会**关闭**导入缓存
 * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。修订 alpha 之后 beta 的导入永远作废——崩溃后重建
 * 出来的表在这条路径上只用来证明「关门判定从事件恢复」，命中路径见 world 节点用例。
 */
const TWO_ACTOR_SCRIPT = [
  "interface Answer { text: string }",
  'const alpha = agent("alpha");',
  'const beta = agent("beta");',
  'const a = await alpha.ask<Answer>("alpha question");',
  'const b = await beta.ask<Answer>("beta question");',
  "return `${a.text}|${b.text}`;",
].join("\n");

/** A run's node-settled events (with the cached flag), in occurrence order. */
function settledEvents(
  harness: Harness,
  runId: string,
): { siteId: string; ordinal: number; cached: boolean }[] {
  return harness.runEvents
    .filter((event) => event.runId === runId && event.eventType === "node-settled")
    .map((event) => {
      const instance = event.payload.instance as { siteId: string; ordinal: number };
      return { ...instance, cached: event.payload.cached === true };
    });
}

/** How many times the model was really called (each turn of the scriptedModelAdapter). */
function turnCount(harness: Harness): number {
  return harness.order.filter((entry) => entry.startsWith("turn:")).length;
}

/**
 * Hides a run from `getRun` (the predecessor-was-cleaned-up case). The in-memory journal has no
 * delete face, and this degradation path's observation point happens to be getRun alone — the
 * Proxy overrides exactly that method and forwards everything else (including orphan convergence /
 * enumeration capability probing) as-is.
 */
function withHiddenRun(journal: JournalStorePort, hiddenRunId: string): JournalStorePort {
  return new Proxy(journal, {
    get(target, prop) {
      if (prop === "getRun") {
        return (runId: string) => (runId === hiddenRunId ? undefined : journal.getRun(runId));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  }) as JournalStorePort;
}

// docs/dynamic-workflow/launch.md "Keeping the predecessor's script": an AmendWorkflow omitting
// `script` reads the predecessor's archived script via getScript in resolveInput — the same bytes
// resume replays; the `path`-amendment's `script_unchanged` precheck reads it too (comparing
// **bytes**, not a hash). It is its own read face and does not enter the getTask snapshot: the
// snapshot is polled by the background tracker, and the script is the port's largest string.
describe("dynamic workflow run service — getScript（修订沿用前驱的脚本）", () => {
  it("回 journal 行上逐字节的 script_text（不 trim、不改换行）", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    const script = `${TYPED_SCRIPT}\r\n// 尾注：逐字节\n\n`;
    preloadRun(journal, { runId: "dwfrun-stored", scriptText: script, status: "errored" });

    expect(await harness.service.getScript!("dwfrun-stored")).toBe(script);
  });

  it("行上没有脚本（落库之前的老 run）与未知 run 都回 undefined", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-scriptless", status: "completed" });

    expect(await harness.service.getScript!("dwfrun-scriptless")).toBeUndefined();
    expect(await harness.service.getScript!("dwfrun-nope")).toBeUndefined();
  });

  it("submit → createRun 的间隙里读注册表条目上的脚本", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const harness = makeHarness({ hangActors: true, journal: hideRunsFromReads(real, hidden) });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("get-script-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getScript!(runId)).toBe(TYPED_SCRIPT);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("关闭之后仍可读：它是只读面，不是启动入口", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-closed", scriptText: TYPED_SCRIPT, status: "completed" });
    await harness.service.close();

    expect(await harness.service.getScript!("dwfrun-closed")).toBe(TYPED_SCRIPT);
  });
});

describe("dynamic workflow run service — amend 的门", () => {
  it("前驱不存在 → run_not_found，且不建任何 run", async () => {
    const journal = new SweepableJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const harness = makeHarness({ journal });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: "dwfrun-nope",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-missing"),
    });

    expect(result).toEqual({ ok: false, reason: "run_not_found" });
    // Rejection has zero side effects: no row, no registry entry, no live engine.
    expect(createRun).not.toHaveBeenCalled();
    expect(harness.actorRuntimeInputs).toEqual([]);
  });

  // docs/execution-engine.md "Amend-resume": an in-flight predecessor is no longer rejected (the old
  // `not_amendable`) — amend stops it with `{ superseded: newRunId }`, waits for settlement, then
  // imports and starts the successor — one invocation, no "stop, poll until stopped, re-submit" race.
  it("前驱仍在飞 → 停下成 stopped(superseded, supersededBy)、等结算、再启动后继", async () => {
    const harness = makeHarness({ hangActors: true });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      name: "triage",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-live-a"),
    });
    // Wait for the actor session to come up (ask dispatched, turn in flight), then amend.
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-live-b"),
    });
    const runB = amended.runId;
    expect(runB).not.toBe(runA);
    expect(amended.supersededRunId).toBe(runA);

    // When amend returns, the predecessor has settled (what was awaited is its own settlement promise, not a timeout).
    const a = harness.journal.getRun(runA);
    expect(a).toMatchObject({ status: "stopped", stopReason: "superseded", supersededBy: runB });
    expect(a?.failure).toBeUndefined();
    const snapshotA = await harness.service.getTask(runA);
    expect(snapshotA).toMatchObject({
      runStatus: "stopped",
      stopReason: "superseded",
      supersededBy: runB,
    });
    // The superseded run is unrecoverable; the successor carries a lineage pointer and reuses the predecessor's name.
    expect(await harness.service.resume(runA)).toEqual({ ok: false, reason: "superseded" });
    expect((await harness.service.getTask(runB))?.resumedFrom).toBe(runA);
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runB)).toMatchObject({ resumedFrom: runA, name: "triage" });
    });

    // Progress payloads: the predecessor's run-settled carries supersededBy and **no** resumable; the successor's run-started carries resumedFrom.
    const settledA = harness.runEvents.find(
      (event) => event.runId === runA && event.eventType === "run-settled",
    );
    expect(settledA?.payload).toMatchObject({ stopReason: "superseded", supersededBy: runB });
    expect(settledA?.payload).not.toHaveProperty("resumable");
    const startedB = harness.runEvents.find(
      (event) => event.runId === runB && event.eventType === "run-started",
    );
    expect(startedB?.payload).toMatchObject({ resumedFrom: runA });

    // Wrap-up: the successor hangs too (the same hung actor script); the user cancels it.
    expect(await harness.service.cancel(runB)).toBe(true);
    await settle(harness, runB);
  });

  it("预检失败时在飞前驱不被停下", async () => {
    const harness = makeHarness({ hangActors: true });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-preflight-a"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    // Leave one of the predecessor's completed asks without a boundary: the precheck must reject before the stop.
    harness.journal.putNode({
      runId: runA,
      siteId: "ask#99",
      ordinal: 99,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 7,
      inputHash: "h99",
      status: "completed",
      result: { text: "done" },
    });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-preflight-b"),
    });
    expect(result).toEqual({ ok: false, reason: "missing_boundaries" });
    expect(harness.journal.getRun(runA)?.status).toBe("running");
    expect(harness.service.countLiveRuns()).toBe(1);

    expect(await harness.service.cancel(runA)).toBe(true);
    await settle(harness, runA);
  });

  it("前驱的已完结 ask 缺边界 marker → missing_boundaries", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-old", scriptText: TYPED_SCRIPT, status: "completed" });
    journal.putActor({
      runId: "dwfrun-old",
      siteId: "actor#1",
      ordinal: 1,
      name: "worker",
      persona: { name: "worker" },
      sessionId: "sess-old",
    });
    journal.putNode({
      runId: "dwfrun-old",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h0",
      status: "completed",
      result: { text: "done" },
    });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: "dwfrun-old",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-no-marker"),
    });

    expect(result).toEqual({ ok: false, reason: "missing_boundaries" });
  });

  // Amendable set = any terminal state. completed and "the script genuinely failed" are exactly the two kinds plain resume excludes and amendment serves best.
  it.each(["completed", "errored", "stopped"] as const)("终态 %s 的前驱通过门", async (status) => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: `dwfrun-${status}`, scriptText: TYPED_SCRIPT, status });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: `dwfrun-${status}`,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(`amend-${status}`),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The predecessor settled long ago: no supersededRunId.
    expect(result.supersededRunId).toBeUndefined();
    await settle(harness, result.runId);
    expect(harness.journal.getRun(result.runId)?.resumedFrom).toBe(`dwfrun-${status}`);
  });
});

describe("dynamic workflow run service — amend-resume 的温启动", () => {
  // End-to-end evidence for docs/dynamic-workflow/launch.md "Keeping the predecessor's script":
  // the real AmendWorkflow tool (executor → resolveInput → getScript → prepareApproval → handler)
  // wired to the real run service. A ceiling-only amendment runs the predecessor's byte-identical
  // script, so every ask hits cache: zero turns, yet the ceiling moves to the new value.
  it("AmendWorkflow 省略 script：工具经 getScript 沿用前驱脚本，全部命中缓存、只换上界", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-keep-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const script = amendScript("second question");
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: script,
        trace: traceFor("amend-keep-predecessor"),
      });
      await settle(before, runA);
      expect(journal.getRun(runA)?.caps.maxConcurrency).not.toBe(1);

      // The amended run's actor has no scripted answers at all: one ask going live and it cannot get a result.
      const after = makeHarness({ journal, sessionStore: store as never });
      const registry = createToolRegistry();
      const amendEntry = builtInTools.find((entry) => entry.metadata.name === "AmendWorkflow");
      expect(amendEntry).toBeDefined();
      registry.register(amendEntry!);
      const sessionId = createSessionId("amend-keep-tool");
      const turnId = createTurnId("amend-keep-tool");
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const permissionAsks: string[] = [];
      const executor = createToolExecutor({
        emitEvent: async () => {},
        dynamicWorkflowRunPort: after.service,
        mode: "build",
        // The predecessor does not belong to this session (submit carried no parentSessionId): a dialog appears; approve it here.
        permissionBroker: {
          async requestPermission(request) {
            permissionAsks.push(JSON.stringify(request));
            return { decision: "allow" as const };
          },
        },
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        turnId,
        traceContext,
        workingDirectory: TEST_CWD,
      });

      const result = await executor.execute(
        {
          id: createToolCallId("amend-keep-tool"),
          input: { run_id: runA, max_concurrency: 1 },
          name: "AmendWorkflow",
        },
        { traceContext },
      );

      expect(result.success).toBe(true);
      // The confirmation dialog reviews the script that will run (backfilled into the parameters), carrying the "carry over" flag.
      expect(permissionAsks).toHaveLength(1);
      expect(permissionAsks[0]).toContain('"script_inherited":true');
      const output = result.output as { backgroundTaskId?: string; response: string };
      const runB = output.backgroundTaskId;
      expect(runB).toBeDefined();
      expect(output.response).toContain(`The script of run ${runA} started unchanged`);
      await settle(after, runB!);

      const rowB = journal.getRun(runB!);
      expect(rowB?.scriptText).toBe(script);
      expect(rowB?.caps.maxConcurrency).toBe(1);
      expect(rowB?.resumedFrom).toBe(runA);
      // The carried-over script gets a home too (docs/dynamic-workflow/launch.md "Provenance"):
      // the predecessor recorded no file, so the tool writes the archived script to a draft and the
      // new run records that — the next amendment edits this file instead of re-copying it inline.
      const recordedScriptPath = (await after.service.getTask(runB!))?.scriptPath;
      expect(recordedScriptPath).toBeDefined();
      expect(readFileSync(recordedScriptPath!, "utf8")).toBe(script);
      expect((await after.service.getTask(runB!))?.output).toBe("one|two|0");
      expect(turnCount(after)).toBe(0);
      expect(settledEvents(after, runB!)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: true },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // End-to-end evidence for docs/dynamic-workflow/presentation.md "Subagent transcripts" and
  // "Reduction": an amended run starts from an empty table, with cache hits and no node-queued —
  // the cached settlement must name the subagent itself, or a fully-hit subagent shows "not
  // started" in the GUI and "never launched" when opened (user report 2026-09-22).
  it("修订 run 的缓存命中归到子代理名下，transcript 指向前驱里真有消息的那条会话；分歧后换回本 run 的", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-attrib-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-attrib-predecessor"),
      });
      await settle(before, runA);
      const predecessorSession = before.runEvents.find(
        (event) => event.runId === runA && event.eventType === "actor-created",
      )?.actorSessionId;
      expect(predecessorSession).toBeDefined();
      expect((await store.messages({ sessionID: predecessorSession! })).length).toBeGreaterThan(0);

      // ——— An amendment of the same script: every ask hits, zero turns.
      const same = makeHarness({ journal, sessionStore: store as never });
      const unchanged = await amendRun(same, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-attrib-same"),
      });
      await settle(same, unchanged.runId);
      expect(turnCount(same)).toBe(0);
      const ownSession = same.runEvents.find(
        (event) => event.runId === unchanged.runId && event.eventType === "actor-created",
      )?.actorSessionId;
      expect(ownSession).toBeDefined();
      expect(ownSession).not.toBe(predecessorSession);

      const cachedRun = reduceAll(same)?.runs.find((run) => run.runId === unchanged.runId);
      expect(
        cachedRun?.nodes.map((node) => [
          node.siteId,
          node.cached === true,
          node.actorSiteId === undefined ? null : `${node.actorSiteId}@${node.actorOrdinal}`,
        ]),
      ).toEqual([
        ["world-read#1", true, null],
        ["ask#1", true, "actor#1@1"],
        ["ask#2", true, "actor#1@1"],
      ]);
      expect(cachedRun?.nodes.find((node) => node.siteId === "ask#2")?.instructionsHead).toBe(
        "second question",
      );
      // This run never built a session for it: the transcript is read from the predecessor, and that session really has messages.
      expect(cachedRun?.actors).toMatchObject([
        { siteId: "actor#1", ordinal: 1, status: "completed", sessionId: predecessorSession },
      ]);

      // ——— An amendment that changed the second ask: the first hits (predecessor session), the second runs live (this run's session, seeded with the prefix).
      const diverged = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const revised = await amendRun(diverged, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-attrib-revised"),
      });
      await settle(diverged, revised.runId);
      const revisedSession = diverged.runEvents.find(
        (event) => event.runId === revised.runId && event.eventType === "actor-created",
      )?.actorSessionId;
      const firstSettle = diverged.runEvents.find(
        (event) =>
          event.runId === revised.runId &&
          event.eventType === "node-settled" &&
          (event.payload.instance as { siteId: string }).siteId === "ask#1",
      );
      expect(firstSettle?.payload).toMatchObject({
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        sourceSessionId: predecessorSession,
      });
      const revisedRun = reduceAll(diverged)?.runs.find((run) => run.runId === revised.runId);
      expect(revisedRun?.actors).toMatchObject([
        { siteId: "actor#1", status: "completed", sessionId: revisedSession },
      ]);
      expect((await store.messages({ sessionID: revisedSession! })).length).toBeGreaterThan(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("前缀零派发命中、分歧点起 live、边界与 lineage 落库", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // ——— Predecessor run: both asks live, boundaries and sessions really persisted.
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-predecessor"),
      });
      await settle(before, runA);
      expect((await before.service.getTask(runA))?.output).toBe("one|two|0");
      expect(turnCount(before)).toBe(2);

      // ——— Amended run: only the second ask changed.
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const submitted = await after.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-run"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await settle(after, runB);

      // The first ask's answer comes verbatim from the predecessor; the second is freshly run.
      expect((await after.service.getTask(runB))?.output).toBe("one|revised|0");
      // The one dispatch after the divergence is the **only** one: zero tokens and zero calls for the prefix.
      expect(turnCount(after)).toBe(1);

      // The world-read and the seq-0 ask settle as cached; the diverging seq 1 does not.
      const settledB = settledEvents(after, runB);
      expect(settledB).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // A hit always lands a **real row**, with the boundary copied along — otherwise runB itself could no longer be amended (the foundation of chained amendments).
      const cachedNode = journal.getNode(runB, "ask#1", 1);
      const sourceNode = journal.getNode(runA, "ask#1", 1);
      expect(cachedNode?.status).toBe("completed");
      expect(cachedNode?.result).toEqual({ text: "one" });
      expect(cachedNode?.messageBoundary).toBe(sourceNode?.messageBoundary);
      expect(cachedNode?.actorSeq).toBe(0);

      // lineage is a row-level fact: the confirmation dialog's and detail page's "continued from run X" render from it.
      expect(journal.getRun(runB)?.resumedFrom).toBe(runA);
      // Predecessor read-only: not one byte of runA's rows and nodes moved.
      expect(journal.getRun(runA)?.status).toBe("completed");
      expect(journal.getRun(runA)?.resumedFrom).toBeUndefined();

      // The diverging actor's session is a **truncated copy**: a new session id whose content is the source session's first N entries.
      const sourceSession = journal.getActor(runA, "actor#1", 1)?.sessionId;
      const amendedSession = after.actorRuntimeInputs[0]!.sessionId;
      expect(amendedSession).not.toBe(sourceSession);
      // The session holds the copied prefix first, then the diverging ask's own messages, so its length is **strictly greater** than the boundary.
      const seeded = await store.messages({ sessionID: amendedSession });
      expect(seeded.length).toBeGreaterThan(sourceNode!.messageBoundary!);
      // Bookkeeping continues on top of the copied prefix: the new run's own boundary = the session
      // length at this moment. The count offset staying invariant across prefix copying is exactly
      // what lets runB be a predecessor again (chained amendments).
      expect(journal.getNode(runB, "ask#2", 1)?.messageBoundary).toBe(seeded.length);
      // After copying, the existing rehydration machinery runs — not a second hydration path.
      expect(after.resumeCalls).toContain(amendedSession);

      // pin inheritance: at the amended run's first dispatch this run has no resolved result yet, so the pin can only come from the predecessor.
      expect(after.actorRuntimeInputs[0]!.pinnedModel).toBe(
        journal.getActor(runA, "actor#1", 1)?.resolvedModel,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // ————————————————————————————————————————————————————————————————
  // Continuing an in-flight ask (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
  // 「What is imported」「How the engine consumes the cache」）
  // ————————————————————————————————————————————————————————————————

  /** Each message's "role + body" in a session; seed copying re-mints ids, so only the body survives cross-session comparison. */
  async function transcriptOf(
    store: { messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> },
    sessionId: SessionId,
  ): Promise<string[]> {
    const messages = await store.messages({ sessionID: sessionId });
    return messages.map((message) => {
      const text = message.parts
        .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
        .join("");
      return `${message.info.role}:${text}`;
    });
  }

  /**
   * The predecessor runs to "ask one completed, ask two in flight", then stops, and is amended with a **byte-identical** script.
   *
   * This is exactly the half-conversation this feature rescues: ask two never settled, has no
   * boundary to import, yet the transcript segment it already ran still sits in the predecessor's
   * session. The amendment re-issues the same instruction at the same position (inputHash matches),
   * so the new session must continue from that transcript instead of throwing it away.
   */
  /**
   * The "ask one completed, ask two in flight" predecessor runs on the **same** service (an
   * in-flight run can only be stopped by the service that owns it, see amendDynamicWorkflowRun's
   * in-flight decision).
   *
   * `plan` is a **mutable** plan table: the predecessor's adapter already handed out its hang
   * promise and will never read it again; the amended run's actor runtime is freshly built and
   * rereads the table from index 0. So swapping the table's contents equals giving the successor a
   * new set of answers.
   */
  async function liveMidAskPredecessor(input: {
    journal: SweepableJournalStore;
    label: string;
    quiesceMs?: number;
    script: string;
    /** How the second ask hangs: honoring cancel (a normal provider) or ignoring even cancel (the session never finishes writing). */
    stall: "hang-until-cancelled" | "hang";
    store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  }): Promise<{ harness: Harness; plan: ActorPlan[]; prefixBoundary: number; runA: string }> {
    const { journal, label, script, stall, store } = input;
    const plan: ActorPlan[] = [{ kind: "submit", result: { text: "one" } }, { kind: stall }];
    const harness = makeHarness({
      actorScripts: { "actor#1@1": plan },
      journal,
      ...(input.quiesceMs === undefined ? {} : { quiesceMs: input.quiesceMs }),
      sessionStore: store as never,
    });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: script,
      trace: traceFor(`${label}-a`),
    });
    // Wait until the second ask is truly dispatched (the second turn has started) and the first ask's boundary is written.
    await vi.waitFor(() => {
      expect(turnCount(harness)).toBe(2);
      expect(journal.getNode(runA, "ask#1", 1)?.messageBoundary).toBeDefined();
    });
    // The in-flight ask has a row, is running, and has no boundary of its own — exactly the one to be continued.
    expect(journal.getNode(runA, "ask#2", 1)).toMatchObject({ status: "running", actorSeq: 1 });
    expect(journal.getNode(runA, "ask#2", 1)?.messageBoundary).toBeUndefined();
    plan.length = 0;
    plan.push({ kind: "submit", result: { text: "revised" } });
    return {
      harness,
      plan,
      prefixBoundary: journal.getNode(runA, "ask#1", 1)!.messageBoundary!,
      runA,
    };
  }

  it("前驱在飞的 ask 被同一条指令续上：新会话以前驱**整段**转录开场", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    const script = amendScript("second question");
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight",
        script,
        stall: "hang-until-cancelled",
        store,
      });

      // ——— Amend: the script is byte-identical, so the second ask's inputHash matches the in-flight one.
      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: script,
        trace: traceFor("amend-inflight-b"),
      });
      const runB = amended.runId;
      expect(amended.supersededRunId).toBe(runA);
      await settle(harness, runB);

      // The predecessor's half-conversation really is longer than ask one's boundary — otherwise this case proves nothing.
      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);

      // Ask one hits the cache as usual; ask two runs live (it is the continued ask).
      expect((await harness.service.getTask(runB))?.output).toBe("one|revised|0");
      expect(settledEvents(harness, runB)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // Core assertion: the new session's opening **item by item** is the predecessor's whole
      // transcript (including the unfinished half-conversation), not just up to ask one's boundary.
      const amendedSession = journal.getActor(runB, "actor#1", 1)!.sessionId! as SessionId;
      expect(amendedSession).not.toBe(sourceSession);
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).toEqual(
        predecessorTranscript,
      );
      // After continuation the ask runs live as usual, so the session is longer still.
      expect(amendedTranscript.length).toBeGreaterThan(predecessorTranscript.length);

      // The continued ask's stats record no worldToolCalls: its transcript existed before this
      // dispatch, and the in-memory tool counter only counts the rounds it ran itself; reporting 0
      // would be read by a later amendment as "pure".
      const carried = journal.getNode(runB, "ask#2", 1);
      expect(carried?.status).toBe("completed");
      expect(carried?.stats?.worldToolCalls).toBeUndefined();
      // Bookkeeping still continues on top of the continued transcript, so runB can be a predecessor again (the foundation of chained amendments).
      expect(carried?.messageBoundary).toBe(amendedTranscript.length);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  /**
   * Same shape, only the second ask's body changed: inputHash no longer matches, so that
   * half-conversation is **no longer** this instruction's context. The new session continues only
   * up to ask one's boundary and the in-flight segment is discarded — the pre-feature behavior.
   */
  it("修订改掉了在飞的那条指令：不接续，新会话只到完结前缀的边界", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-miss-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight-miss",
        script: amendScript("second question"),
        stall: "hang-until-cancelled",
        store,
      });

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-inflight-miss-b"),
      });
      await settle(harness, amended.runId);

      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      // The predecessor really has an in-flight transcript to discard (control and experiment groups face the same shape).
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);

      // The new session's opening is exactly the **prefix** entries; not one entry of the in-flight segment came over.
      const amendedSession = journal.getActor(amended.runId, "actor#1", 1)!.sessionId! as SessionId;
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, prefixBoundary)).toEqual(
        predecessorTranscript.slice(0, prefixBoundary),
      );
      // The **direct negation** of the continuation case's core assertion: the new session does not open with the predecessor's whole transcript.
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).not.toEqual(
        predecessorTranscript,
      );
      // The instruction changed, so the predecessor's half-conversation prompt body never appears in the new session.
      expect(amendedTranscript).not.toContain(predecessorTranscript[prefixBoundary]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  /**
   * End-to-end evidence for the silent gate (driver's ledger → amend → builder): the predecessor's second ask ignores even cancel,
   * 它的 turn 永远落不了地，于是那个会话「写完了没有」永远答不上来。
   *
   * 闸门到点后**不**把它当静默继续用：接续取消，完结前缀照旧导入——正是本特性之前的行为。
   */
  it("前驱会话到点仍在被写 → 不接续，完结前缀照旧导入", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-noisy-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    const script = amendScript("second question");
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight-noisy",
        // 真等满 5 秒没有意义：闸门的上界可注入，正是为了让这条路可测。
        quiesceMs: 5,
        script,
        stall: "hang",
        store,
      });

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        // 指令逐字节相同——所以**只有**静默闸门能解释「没接上」。
        scriptText: script,
        trace: traceFor("amend-inflight-noisy-b"),
      });
      await settle(harness, amended.runId);

      // 前缀照旧命中（它的边界是 journal 事实，与会话此刻长不长无关）。
      expect(settledEvents(harness, amended.runId)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);
      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      // 前驱确实有一段在飞转录**可以**被带走，所以「没带走」只能是闸门的功劳。
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);
      const amendedSession = journal.getActor(amended.runId, "actor#1", 1)!.sessionId! as SessionId;
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, prefixBoundary)).toEqual(
        predecessorTranscript.slice(0, prefixBoundary),
      );
      // 指令逐字节相同，所以提问正文本来就会再出现一次——能分辨「接没接上」的只有这一条：
      // 新会话不以前驱的**整段**转录开场（在飞那半场的回答没被带过来）。
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).not.toEqual(
        predecessorTranscript,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — 脚本读到的 run 身份", () => {
  // The facade's `run` (docs/dynamic-workflow/authoring.md "The run's identity"): an amend gets a new id with
  // `resumedFrom` pointing at the predecessor; a resume keeps the same id and reads the predecessor id back from the
  // journal. The resume input does not carry it, so without the read-back the script would see undefined in the resumed life.
  // The run identity goes only into the return value, not into the ask prompt (the cache key); the amend forks by changing the question text so the subagent really dispatches.
  const identityScript = (question: string): string =>
    [
      "interface Answer { text: string }",
      `const a = await agent("worker").ask<Answer>(${JSON.stringify(question)});`,
      'return `${run.id}|${run.resumedFrom ?? "-"}|${a.text}`;',
    ].join("\n");

  it("新 run 无前驱；amend 得新 id 并指向前驱；resume 沿用 id 与前驱", async () => {
    // The amend reads the predecessor's message boundary, so the session is really persisted (same as the "prefix zero-dispatch hit" case).
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-run-identity-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      await runIdentityLifecycle(store);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  async function runIdentityLifecycle(
    store: Awaited<ReturnType<typeof createSqliteSessionStore>>,
  ): Promise<void> {
    const journal = new SweepableJournalStore();
    const options: HarnessOptions = {
      journal,
      sessionStore: store as never,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "a" } }] },
    };
    const harness = makeHarness(options);

    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: identityScript("first"),
      trace: traceFor("run-identity-a"),
    });
    await settle(harness, runA);
    expect((await harness.service.getTask(runA))?.output).toBe(`${runA}|-|a`);

    // After the amend the subagent hangs, so the run stops at a resumable point.
    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    const { runId: runB } = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: identityScript("amended"),
      trace: traceFor("run-identity-b"),
    });
    expect(runB).not.toBe(runA);
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(2);
    });
    expect(await harness.service.cancel(runB)).toBe(true);
    await settle(harness, runB);

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "b" } }] };
    expect(await harness.service.resume!(runB)).toMatchObject({ ok: true, runId: runB });
    await settle(harness, runB);
    expect((await harness.service.getTask(runB))?.output).toBe(`${runB}|${runA}|b`);
  }
});

describe("dynamic workflow run service — 用量沿 lineage 累计", () => {
  /**
   * 一轮 scripted turn 的 token 数（见本文件顶部 scriptedModelAdapter 的 usage）。
   * 用量断言要的是准确数字而不是「大于零」：继承来的那部分与本次现跑的那部分必须分得开。
   */
  const TOKENS_PER_TURN = 20;

  it("后继 run 从前驱总量起账：命中不加钱、live turn 才加，前驱行分文不动；链式修订按构造求和", async () => {
    // docs/dynamic-workflow/launch.md「The AmendWorkflow tool」：完成卡与详情页上的 token 是
    // **整条 lineage** 的花费。真 session store：命中要拷消息边界，而预检要求每个完结 ask 都有边界，
    // 链式修订（runB 再作前驱）全靠这条。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-lineage-tokens-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // —— 前驱 runA：两问都 live = 两轮 turn。
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("lineage-tokens-a"),
      });
      await settle(before, runA);
      expect(turnCount(before)).toBe(2);
      const totalA = 2 * TOKENS_PER_TURN;
      expect(journal.getRun(runA)?.spentTokens).toBe(totalA);

      // —— 修订 runB：第一问命中、第二问 live = 一轮 turn。
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const runB = await amendRun(after, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("lineage-tokens-b"),
      });
      await settle(after, runB.runId);
      expect(turnCount(after)).toBe(1);

      // 继承 + 本次现跑的一轮。命中的那一问一分钱都没有再加（它的账在继承值里）。
      const totalB = totalA + TOKENS_PER_TURN;
      expect(journal.getRun(runB.runId)?.spentTokens).toBe(totalB);
      expect(settledEvents(after, runB.runId)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // 前驱只读：lineage 因此保留「上一版花了多少」这段历史。
      expect(journal.getRun(runA)?.spentTokens).toBe(totalA);

      // 投影面：run-started 把用量清零，紧跟其后的第一条 usage-updated 必须已经是继承值——
      // 否则卡片在第一轮 live turn 落地之前会显示 0（也就是「这次修订还没花钱」的假象）。
      const usageB = after.runEvents.filter(
        (event) => event.runId === runB.runId && event.eventType === "usage-updated",
      );
      expect(usageB[0]?.payload.spentTokens).toBe(totalA);
      expect(usageB.at(-1)?.payload.spentTokens).toBe(totalB);
      const typesB = after.runEvents
        .filter((event) => event.runId === runB.runId)
        .map((event) => event.eventType);
      // 补发那条落在起手序幕里：它之前只允许出现 run-started 与 run-launched（修订路一定带锚点），
      // 绝不允许任何 actor / node 事件——否则卡片在第一次派发时就已经显示过 0。
      expect(typesB.slice(0, typesB.indexOf("usage-updated"))).toEqual([
        "run-started",
        "run-launched",
      ]);

      // —— 链式修订 runC：每个前驱的数字本身已是累计值，所以求和是构造出来的，没人走 resumedFrom 链。
      const third = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised twice" } }] },
        journal,
        sessionStore: store as never,
      });
      const runC = await amendRun(third, {
        cwd: TEST_CWD,
        predecessorRunId: runB.runId,
        scriptText: amendScript("second question, revised twice"),
        trace: traceFor("lineage-tokens-c"),
      });
      await settle(third, runC.runId);
      expect(turnCount(third)).toBe(1);
      expect(journal.getRun(runC.runId)?.spentTokens).toBe(totalB + TOKENS_PER_TURN);
      expect(journal.getRun(runB.runId)?.spentTokens).toBe(totalB);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("全新 submit 从零起账（继承只发生在 amend 路上）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lineage-tokens-fresh"),
    });
    await settle(harness, runId);
    // 头一条 usage-updated 就是本 run 自己第一轮的花费，不是继承值（缺席即零，不发补发那条）。
    const usage = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "usage-updated",
    );
    expect(usage[0]?.payload.spentTokens).toBe(TOKENS_PER_TURN);
    expect(harness.journal.getRun(runId)?.spentTokens).toBe(turnCount(harness) * TOKENS_PER_TURN);
  });

  it("间隙读面（dwf_run 行藏起来）报继承值而不是 0", async () => {
    // 间隙 = 注册表已有条目、journal 还没有行（藏读模拟，见 hideRunsFromReads）。修订 run 在这里
    // 报 0 会说「这条 lineage 没花钱」，而它的起点在 amend 那一刻就已确定。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-lineage-gap-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const real = resolveDynamicWorkflowJournalStore(store as never) as JournalStorePort &
        DwfRunIntrospectionQueries;
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      // 前驱：第一问 submit（一轮 turn 的用量 + 一条消息边界，预检要它），第二问挂住后被取消。
      const harness = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "one" } }, { kind: "hang" }],
        },
        journal,
        // `hang` 的 turn 连取消都不理会，所以 amend 的静默闸门会等满上界才放行
        // （workflow-driver-quiescence.ts）。本用例算的是 token，不必陪它等 5 秒。
        quiesceMs: 5,
        sessionStore: store as never,
      });
      const predecessor = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: amendScript("second question"),
        trace: traceFor("lineage-gap-a"),
      });
      await vi.waitFor(() => {
        expect(real.getRun(predecessor)?.spentTokens).toBe(TOKENS_PER_TURN);
      });
      expect(await harness.service.cancel(predecessor)).toBe(true);
      await settle(harness, predecessor);
      const inherited = real.getRun(predecessor)!.spentTokens;
      expect(inherited).toBe(TOKENS_PER_TURN);

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: predecessor,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("lineage-gap-b"),
      });
      await settle(harness, amended.runId);
      // 落行后：继承值 + 本次现跑的一轮。
      expect(real.getRun(amended.runId)?.spentTokens).toBe(inherited + TOKENS_PER_TURN);

      // 藏掉行 ⇒ 走注册表间隙分支：报得出继承值（条目只知道起点，这已经比 0 诚实）。
      hidden.add(amended.runId);
      const gap = await introspectionOf(harness).getRunDetail(amended.runId);
      expect(gap?.usage).toMatchObject({ nodesObserved: 0, spentTokens: inherited });
      const listed = await introspectionOf(harness).listRuns({ cwd: TEST_CWD, limit: 8 });
      const gapRow = listed.runs.find((row) => row.runId === amended.runId);
      expect(gapRow?.spentTokens).toBe(inherited);

      // 全新 submit 的条目没有起点 ⇒ 间隙照旧报 0（继承只发生在 amend 路上）。
      const fresh = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("lineage-gap-fresh"),
      });
      hidden.add(fresh);
      expect((await introspectionOf(harness).getRunDetail(fresh))?.usage.spentTokens).toBe(0);
      hidden.delete(fresh);
      await harness.service.cancel(fresh);
      await settle(harness, fresh);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — amend-resume 的崩溃后重建", () => {
  it("崩溃后 resume：alpha 曾 live 但没写过工作区 ⇒ 门没关，beta 仍从导入表结算；journal pin 压过承袭的 seed pin", async () => {
    // apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」：runB 里 alpha 分歧转 live 并挂住；进程没了。
    // 转 live 本身不关门——alpha 一个字节都没写，beta 读的工作区就是前驱留下的那个。resume 重建导入表后
    // beta 照常命中。（这条曾断言相反的结论：那时「任一 ask live 即关门」，是拿时钟代替依赖。）
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-resume-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-1" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-two-actor"),
      });
      await settle(before, runA);

      // 修订：只改 alpha 的问题 → alpha 在 seq 0 分歧转 live 并挂住，beta 尚未排队。
      const crashed = makeHarness({ hangActors: true, journal, sessionStore: store as never });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-crash"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await vi.waitFor(() => {
        expect(crashed.actorRuntimeInputs.length).toBeGreaterThan(0);
      });
      expect(await crashed.service.cancel(runB)).toBe(true);
      await settle(crashed, runB);
      // 取消发生在 beta 之前：beta 在 runB 的 journal 里没有任何行；也没有关门事件。
      expect(
        journal
          .listNodes(runB, { kinds: "all", withResult: true })
          .some((node) => node.actorSiteId === "actor#2"),
      ).toBe(false);
      expect(
        journal
          .listEvents(runB, { types: "all", reportItems: "all" })
          .some(({ event }) => event.type === "import-cache-closed"),
      ).toBe(false);

      // journal pin 必须压过承袭的 seed pin：本 run 里实际跑过的模型比前驱的更具体。
      // 两者本应相等，所以这里把 runB 的记录改成一个哨兵值，好让「谁赢」成为可断言的事实。
      const alphaRow = journal.getActor(runB, "actor#1", 1)!;
      journal.putActor({ ...alphaRow, resolvedModel: "sentinel/from-journal" });

      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-2" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      // beta 从重建出来的导入表结算：门从未关过，只有 alpha 真的跑了。
      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-1");
      expect(turnCount(resumed)).toBe(1);
      expect(resumed.actorRuntimeInputs.map((input) => refToString(input.actor))).toEqual([
        "actor#1@1",
      ]);
      expect(settledEvents(resumed, runB)).toContainEqual({
        siteId: "ask#2",
        ordinal: 1,
        cached: true,
      });
      expect(journal.getNode(runB, "ask#2", 1)?.result).toEqual({ text: "beta-1" });

      expect(resumed.actorRuntimeInputs[0]!.pinnedModel).toBe("sentinel/from-journal");
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("崩溃后 resume：alpha 真的写了文件 ⇒ 执行器 → driver → 引擎关门；beta live 重跑（关门判定从 import-cache-closed 恢复）", async () => {
    // 同一场景，两处不同：
    //   1. runA 的 beta **用过工具**（一次 Write），所以它的缓存条目不是「纯」的——它可能读过工作区；
    //   2. runB 的 alpha 挂住之前先调了一次真的 `Write`。执行器在 handler 之前发出带
    //      readOnly:false / sideEffectScope:"workspace" 的 ToolCallStarted，driver 的工具活动观察上报
    //      askMutating，引擎记下 import-cache-closed。
    // resume 只认那条事件；beta 于是 live 重跑——它读的工作区可能已被 alpha 改过。
    // （工具在这套夹具里会因 fakeFileSystemPort 而失败，无妨：ToolCallStarted 在 handler 之前就发了，
    //   而这条链要验的正是「调用发生过」。）
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-resume-write-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [
            { kind: "write", path: join(TEST_CWD, "beta-notes.md"), content: "beta was here" },
            { kind: "submit", result: { text: "beta-1" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-two-actor-write"),
      });
      await settle(before, runA);
      // 夹具前提：beta 在 runA 里确实碰过外部世界（一次 Write），所以它的条目在关门后不再命中；
      // alpha 只交了结果，它的 worldToolCalls 是 0（`submit_result` 只计入 toolCalls）——纯条目，
      // 关门后照样命中（上一条用例走的正是这条路）。
      expect(journal.getNode(runA, "ask#2", 1)?.stats?.worldToolCalls ?? 0).toBeGreaterThan(0);
      expect(journal.getNode(runA, "ask#1", 1)?.stats?.worldToolCalls).toBe(0);

      const crashed = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "write", path: join(TEST_CWD, "notes.md"), content: "alpha was here" },
            { kind: "hang" },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-crash-write"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      // 等到关门事件落 journal：这是整条链（工具层 → driver → 引擎）跑通的证据。
      await vi.waitFor(() => {
        expect(
          journal
            .listEvents(runB, { types: "all", reportItems: "all" })
            .some(({ event }) => event.type === "import-cache-closed"),
        ).toBe(true);
      });
      const closed = journal
        .listEvents(runB, { types: "all", reportItems: "all" })
        .find(({ event }) => event.type === "import-cache-closed")!.event;
      expect(closed).toMatchObject({
        type: "import-cache-closed",
        instance: { siteId: "ask#1", ordinal: 1 },
        cause: "mutating-tool",
        actorName: "alpha",
      });
      expect(await crashed.service.cancel(runB)).toBe(true);
      await settle(crashed, runB);
      expect(
        journal
          .listNodes(runB, { kinds: "all", withResult: true })
          .some((node) => node.actorSiteId === "actor#2"),
      ).toBe(false);

      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-2" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-2");
      expect(turnCount(resumed)).toBe(2);
      expect(resumed.actorRuntimeInputs.map((input) => refToString(input.actor))).toEqual([
        "actor#1@1",
        "actor#2@1",
      ]);
      expect(settledEvents(resumed, runB)).toContainEqual({
        siteId: "ask#2",
        ordinal: 1,
        cached: false,
      });
      expect(journal.getNode(runB, "ask#2", 1)?.result).toEqual({ text: "beta-2" });
      // resume 不重发关门事件：判定是恢复出来的，不是新发生的。
      expect(
        resumed.runEvents.filter(
          (event) => event.runId === runB && event.eventType === "import-cache-closed",
        ),
      ).toHaveLength(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("前驱被清理 → resume 仍成功，未消费的导入降级为 live 重跑", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-lost-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-1" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-lost-predecessor"),
      });
      await settle(before, runA);

      const crashed = makeHarness({ hangActors: true, journal, sessionStore: store as never });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-lost-crash"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await vi.waitFor(() => {
        expect(crashed.actorRuntimeInputs.length).toBeGreaterThan(0);
      });
      await crashed.service.cancel(runB);
      await settle(crashed, runB);

      // 前驱 journal 是修订 run 的**存续依赖，但只是加速结构**：丢了变贵，不变错。
      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-live" } }],
        },
        journal: withHiddenRun(journal, runA),
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      // beta 这次真的跑了模型，答案随之不同——退化的是账单，不是正确性。
      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-live");
      expect(turnCount(resumed)).toBe(2);
      expect(
        resumed.logs.some(
          (entry) => entry.context?.event === "dynamic_workflow.amend.rebuild_skipped",
        ),
      ).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — 升级问答（escalation）", () => {
  /**
   * 起一个 run、等它把 ask 派下去，回 actor 会话的升级端口。
   *
   * `hangActors` 让模型永不 resolve——那正是一次被升级问答阻塞住的 turn 的形状，也是唯一
   * 能让「问题停驻期间 run 照常在飞」成为可断言事实的装配。
   */
  async function inflightEscalatePort(
    harness: Harness,
    name: string,
  ): Promise<{ runId: string; port: WorkflowEscalatePort }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    // ask 真正派下去（driver 记下 currentInstance）之后才谈得上停驻。
    await vi.waitFor(() => {
      expect(harness.runEvents.some((event) => event.eventType === "node-dispatched")).toBe(true);
    });
    const port = harness.actorRuntimeInputs[0]?.escalatePort;
    if (port === undefined) throw new Error("escalatePort missing from actor runtime input");
    return { runId, port };
  }

  it("停驻的问题出现在快照的 pendingQuestions 里，作答后就地清空", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-snapshot");

    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-1"),
      question: "评分上限 95 而通过门槛 96，这个门是不是坏了？",
      trace: traceFor("escalation-snapshot"),
    });

    // 快照兜底：通知被丢弃时，主代理仍能从这里重新发现待答问题。
    const blocked = await harness.service.getTask(runId);
    expect(blocked?.pendingQuestions).toHaveLength(1);
    const question = blocked?.pendingQuestions?.[0];
    expect(question).toMatchObject({
      actor: "actor#1@1",
      // 脚本是 `agent("worker")`，所以有效名一路到达快照——通知面与侧栏因此不必各自
      // 回查 journal.listActors（那份重复迟早会与实时轨对不上）。
      actorName: "worker",
      question: "评分上限 95 而通过门槛 96，这个门是不是坏了？",
    });
    // run 状态全程不动：升级是 ask 内部的一次慢工具调用，不是 run 生命周期事件。
    expect(blocked?.status).toBe("running");
    // 实时轨（侧栏据它渲染）与快照兜底（通知丢弃后据它自愈）报同一个提问时刻——
    // 两条读面上的「已等待 N 分钟」因此不会各说各话。
    const raisedPayload = harness.runEvents.find(
      (event) => event.eventType === "escalation-raised",
    )?.payload;
    expect(raisedPayload?.askedAt).toBe(question?.askedAt);

    const outcome = await harness.service.resolveQuestion?.(question!.qid, "门坏了，按 95 通过。");
    expect(outcome).toEqual({ ok: true, qid: question!.qid });
    await expect(answered).resolves.toMatchObject({
      kind: "answered",
      answer: "门坏了，按 95 通过。",
    });

    const after = await harness.service.getTask(runId);
    // 零条时整字段缺席（与 reports 同规），不发空数组。
    expect(after).not.toHaveProperty("pendingQuestions");
    expect(after?.status).toBe("running");
  });

  // 通知丢弃后的**查询兜底**，也是模型侧唯一的发现面：`ResolveWorkflowQuestion` 只认 qid，
  // 而升级通知有两条已知的丢弃路径（stale branch generation / shutdown）。快照面服务后台
  // 任务追踪器，本条服务 `GetWorkflowRun`——两条读面同源同投影，缺了这一条，通知文案与
  // `unknown_question` 的服务端文案都会指向一个什么都不返回的工具。
  it("停驻的问题同样出现在 getRunDetail 里（GetWorkflowRun 的取数面）", async () => {
    // sqlite journal：getRunDetail / listRuns 是内省查询面，内存 journal 不带它们。
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const { runId, port } = await inflightEscalatePort(harness, "escalation-detail");

      const answered = port.escalate({
        toolCallId: createToolCallId("escalate-detail"),
        question: "两条指令互相矛盾，先满足哪一条？",
        context: "第 3 步要求保留原文，第 5 步要求改写。",
        trace: traceFor("escalation-detail"),
      });

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.pendingQuestions).toHaveLength(1);
      const question = detail?.pendingQuestions?.[0];
      expect(question).toMatchObject({
        actor: "actor#1@1",
        actorName: "worker",
        question: "两条指令互相矛盾，先满足哪一条？",
        context: "第 3 步要求保留原文，第 5 步要求改写。",
      });
      // 与快照同源同投影：同一个 run 在两条读面上必须给出同一个 qid 与同一个提问时刻，
      // 否则「已等待多久」在两处各说各话。
      const snapshotQuestion = (await harness.service.getTask(runId))?.pendingQuestions?.[0];
      expect(question?.qid).toBe(snapshotQuestion?.qid);
      expect(question?.askedAt).toBe(snapshotQuestion?.askedAt);
      // run 状态全程不动。
      expect(detail?.status).toBe("running");

      await harness.service.resolveQuestion?.(question!.qid, "以第 5 步为准。");
      await expect(answered).resolves.toMatchObject({ kind: "answered" });

      // 零条时整字段缺席（与快照同规，不发空数组）。
      expect(await introspectionOf(harness).getRunDetail(runId)).not.toHaveProperty(
        "pendingQuestions",
      );

      // actor 的 turn 仍然挂着（hangActors）；收口后再关库，避免写进一个已关闭的 store。
      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("raised / resolved 两类事件都进了实时轨与事件分页", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-events");

    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-2"),
      question: "这个门坏了吗？",
      trace: traceFor("escalation-events"),
    });
    const qid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    await harness.service.resolveQuestion?.(qid!, "坏了。");
    await answered;

    // 实时轨：progress sink 收到的载荷（Slice 2 的通知生产者读的就是它）。
    const raised = harness.runEvents.find((event) => event.eventType === "escalation-raised");
    // 通知生产者（Slice 2）读的就是这份载荷：结构 ref 定位、actorName 供人读、askedAt 供算等待时长。
    expect(raised?.payload).toMatchObject({
      qid,
      actorName: "worker",
      question: "这个门坏了吗？",
    });
    expect(typeof raised?.payload.askedAt).toBe("number");
    expect(
      harness.runEvents.find((event) => event.eventType === "escalation-resolved")?.payload,
    ).toMatchObject({ answer: "坏了。", qid });

    // durable 轨：既有的事件分页面原样承载新种类（协议层 type 是不透明字符串，契约零加值）。
    const { events: page } = await harness.service.listEvents(runId, {});
    expect(
      page.filter((event) => event.type.startsWith("escalation-")).map((one) => one.type),
    ).toEqual(["escalation-raised", "escalation-resolved"]);
    // sequence 与 journal 的分配一致（driver 侧的 record 与引擎的 record 走同一条截取）。
    expect(page.find((one) => one.type === "escalation-raised")?.sequence).toBe(raised?.sequence);
  });

  it("三类结构化拒绝：未知 id / 已回答 / 不在飞", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-refusals");

    // (1) 未知 id（含死 run 的陈旧 id：停驻项不持久化，重启后都长这样）。
    expect(await harness.service.resolveQuestion?.("dwfq-nonesuch-1", "答案")).toMatchObject({
      ok: false,
      reason: "unknown_question",
    });

    // (2) 已回答。
    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-3"),
      question: "第一个问题",
      trace: traceFor("escalation-refusals"),
    });
    const firstQid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    await harness.service.resolveQuestion?.(firstQid!, "答案一");
    await answered;
    expect(await harness.service.resolveQuestion?.(firstQid!, "答案二")).toMatchObject({
      ok: false,
      reason: "already_resolved",
    });

    // (3) run 被取消 → 停驻项随 cancelAsk 撤下 → 之后作答得到 run_not_in_flight。
    const cancelled = port.escalate({
      toolCallId: createToolCallId("escalate-4"),
      question: "第二个问题",
      trace: traceFor("escalation-refusals"),
    });
    const secondQid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    expect(await harness.service.cancel(runId)).toBe(true);
    await expect(cancelled).rejects.toMatchObject({ code: "Cancelled" });
    await settle(harness, runId);

    expect(await harness.service.resolveQuestion?.(secondQid!, "答案三")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
    // 取消的语义与今天逐字节一致：ask 拒 Cancelled，run 结算 cancelled（因而可 resume）。
    expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
  });

  it("一张停驻表跨本服务的多个在飞 run，qid 互不碰撞且 pendingQuestions 按 run 隔离", async () => {
    const harness = makeHarness({ hangActors: true });
    const first = await inflightEscalatePort(harness, "escalation-multi-a");
    const secondRunId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("escalation-multi-b"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBe(2);
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.filter((event) => event.eventType === "node-dispatched").length,
      ).toBe(2);
    });
    const secondPort = harness.actorRuntimeInputs[1]!.escalatePort;

    void first.port
      .escalate({
        toolCallId: createToolCallId("escalate-a"),
        question: "A 的问题",
        trace: traceFor("escalation-multi-a"),
      })
      .catch(() => {});
    void secondPort
      .escalate({
        toolCallId: createToolCallId("escalate-b"),
        question: "B 的问题",
        trace: traceFor("escalation-multi-b"),
      })
      .catch(() => {});

    const left = (await harness.service.getTask(first.runId))?.pendingQuestions;
    const right = (await harness.service.getTask(secondRunId))?.pendingQuestions;
    expect(left?.map((one) => one.question)).toEqual(["A 的问题"]);
    expect(right?.map((one) => one.question)).toEqual(["B 的问题"]);
    // qid 全局唯一正是「resolveQuestion 只收一个不透明 token」的前提。
    expect(left?.[0]?.qid).not.toBe(right?.[0]?.qid);
  });
});

// ————————————————————————————————————————————————
// 升级问答的端到端闭环（Slice 4）。
//
// 上面那组用例由测试自己持端口扮演模型；这一组把两端都交给真东西：actor 的**模型**发一次
// `escalate` 工具调用，主会话的**模型**发一次 `ResolveWorkflowQuestion` 工具调用，两条路各自
// 经真实工具层（注册门 → 权限 → handler → 端口）落到同一张停驻表上。
//
// 只有在这一层才证明得了、而端口层用例结构上看不见的三件事：
//   1. `escalate` 真的出现在 actor 那一轮的工具面上（端口在场 → includeEscalate → 注册表）。
//      中间任何一环漏掉，端口层的断言仍然全绿，而 actor 撞上坏门时手里根本没有这个工具；
//   2. 答案**逐字**作为工具结果回到 actor 的下一次模型请求——那是「带着答案继续干活」的唯一
//      物理通道，也是 spec 里「问答对整体生活在 actor 轮次转录内部」这条缓存不变式的实处；
//   3. 主代理侧零新接线：一个手上只有 qid 的普通会话，用既有工具面就能把 actor 放行。
// ————————————————————————————————————————————————
describe("dynamic workflow run service — 升级问答的端到端闭环", () => {
  /**
   * 主会话的替身：一个真实 AgentRuntime，注入本服务作为 dwf run 端口（生产里主代理就是这样
   * 拿到 `ResolveWorkflowQuestion` 的——该工具无注册门，端口缺席时才回结构化失败）。模型按
   * 计划先发一次工具调用，再收一段文本结束 turn。
   */
  function mainSessionRuntime(
    service: Harness["service"],
    call: () => { question_id: string; answer: string },
  ): { runtime: AgentRuntime; log: ModelRequestLog } {
    const log: ModelRequestLog = { requests: [] };
    let index = 0;
    const usage = { inputTokens: 9, outputTokens: 4, totalTokens: 13 };
    const runtime = createTestAgentRuntime(
      createSessionId("escalation-main"),
      {
        systemPrompt: "You created this workflow.",
        mode: "yolo",
        subagents: { enabled: false },
        workingDirectory: TEST_CWD,
      },
      {
        dynamicWorkflowRunPort: service,
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: fakeFileSystemPort({}),
        modelAdapter: {
          async generateText(request?: {
            messages?: unknown;
            tools?: readonly { name: string }[];
          }) {
            log.requests.push({ messages: request?.messages, tools: request?.tools });
            if (index++ > 0) {
              return {
                finishReason: "stop",
                model: "scripted",
                providerMetadata: undefined,
                text: "answered.",
                usage,
              };
            }
            return {
              finishReason: "tool-calls",
              model: "scripted",
              providerMetadata: undefined,
              text: "",
              toolCalls: [
                {
                  id: "resolve-question-call-1",
                  name: RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
                  input: call(),
                },
              ],
              usage,
            };
          },
        } as never,
      },
    );
    return { runtime, log };
  }

  /** 起 run 并等第一个问题停驻（主代理侧的发现面就是这张快照）。 */
  async function runUntilParked(
    harness: Harness,
    name: string,
  ): Promise<{
    runId: string;
    question: NonNullable<DynamicWorkflowRunDetail["pendingQuestions"]>[number];
  }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(async () => {
      expect((await harness.service.getTask(runId))?.pendingQuestions).toHaveLength(1);
    });
    const question = (await harness.service.getTask(runId))?.pendingQuestions?.[0];
    if (question === undefined) throw new Error("parked question did not appear in the snapshot");
    return { runId, question };
  }

  const QUESTION = "评分上限 95 而通过门槛 96，这个门是不是坏了？";
  const CONTEXT = "每一项都已拉满，总分仍然是 95。";
  const ANSWER = "门确实坏了：按 95 分通过即可，不要为了凑 96 去改评分口径。";

  it("actor 的模型提问 → 主代理的模型作答 → 答案逐字回到 actor → ask 照常 settle", async () => {
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: QUESTION, context: CONTEXT },
          // 拿到答案之后 actor 继续干活并提交——escalate 不终止 turn，这一步就是证据。
          { kind: "submit", result: { text: "按 95 通过" } },
        ],
      },
    });

    const { runId, question } = await runUntilParked(harness, "escalation-loop");
    expect(question).toMatchObject({
      actor: "actor#1@1",
      actorName: "worker",
      question: QUESTION,
      context: CONTEXT,
    });
    expect(question.qid).toMatch(/^dwfq-/);

    // (1) 工具面：actor 的第一次模型请求里真的带着 escalate。
    const actorRequests = harness.actorModelRequests["actor#1@1"];
    expect(actorRequests?.requests[0]?.tools?.map((tool) => tool.name)).toContain(
      ESCALATE_TOOL_NAME,
    );

    // (2) 主代理侧：一次真的 ResolveWorkflowQuestion 工具调用（手上只有 qid）。
    const main = mainSessionRuntime(harness.service, () => ({
      question_id: question.qid,
      answer: ANSWER,
    }));
    await main.runtime.executeTurn(
      `工作流 run ${runId} 有一个待答问题 ${question.qid}，去回答它。`,
    );

    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("按 95 通过");
    // 结算后停驻表就地清空（零条时整字段缺席）。
    expect(snapshot).not.toHaveProperty("pendingQuestions");

    // (3) 答案逐字回到 actor 的下一次模型请求：这是 actor「带着答案继续」的唯一通道。
    expect(actorRequests?.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(actorRequests?.requests[1]?.messages)).toContain(ANSWER);

    // 主代理拿到的回执带着 qid（「答案已送达、run 并没有因此停下」）。
    expect(JSON.stringify(main.log.requests[1]?.messages)).toContain(question.qid);

    // 事件双轨按序：raised 在前，resolved 在后。
    expect(
      harness.runEvents
        .filter((event) => event.eventType.startsWith("escalation-"))
        .map((event) => event.eventType),
    ).toEqual(["escalation-raised", "escalation-resolved"]);
  });

  it("停驻期间取消 run：actor 的 escalate 调用被打断，之后作答得到 run_not_in_flight", async () => {
    // spec 的「无答案 = 无限期阻塞」有且只有一个逃生舱，就是既有的 cancel。这条用例把它钉在
    // 工具层：停驻的不是一个测试持有的 promise，而是 actor 真实轮次里的一次工具调用。
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: "要不要干脆跳过这个检查？" },
          { kind: "submit", result: { text: "不该走到这里" } },
        ],
      },
    });

    const { runId, question } = await runUntilParked(harness, "escalation-loop-cancel");
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot).not.toHaveProperty("pendingQuestions");
    // 陈旧 qid 的作答得到结构化拒绝，而不是静默成功——静默成功会让主代理以为自己已经答过了。
    expect(await harness.service.resolveQuestion?.(question.qid, "太晚了")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
  });
});

// 阶段进入记录的接缝（docs/dynamic-workflow/presentation.md）：引擎发的
// phase-entered 经 toProgressPayload 有界化后，共享 reducer 真的能归约出 phases / currentPhase。
describe("dynamic workflow run service · phase-entered", () => {
  it("引擎发出的 phase-entered 经进度管线归约成 workflowRuns.phases 与 currentPhase", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: [
        'phase("Prepare");',
        'log("start");',
        "for (let i = 0; i < 2; i++) {",
        '  phase("Work");',
        "  report({ round: i });",
        "}",
        'phase("Wrap up");',
        'return "done";',
      ].join("\n"),
      trace: traceFor("phase-entered"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)).toMatchObject({ status: "completed" });

    const entered = harness.runEvents.filter((event) => event.eventType === "phase-entered");
    expect(entered.map((event) => event.payload)).toEqual([
      { name: "Prepare", ordinal: 1 },
      { name: "Work", ordinal: 1 },
      { name: "Work", ordinal: 2 },
      { name: "Wrap up", ordinal: 1 },
    ]);

    let state: WorkflowRunsState | undefined;
    for (const event of harness.runEvents) {
      state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
    }
    expect(state?.runs[0]?.phases).toEqual([
      { name: "Prepare", rounds: 1 },
      { name: "Work", rounds: 2 },
      { name: "Wrap up", rounds: 1 },
    ]);
    expect(state?.runs[0]?.currentPhase).toBe("Wrap up");
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });
});

// ————————————————————————————————————————————————————————————————
// 出生阶段（docs/dynamic-workflow/presentation.md）
// ————————————————————————————————————————————————————————————————

/**
 * 一个横跨「标记之前 / Prepare / Work」的脚本：每段各建一个 actor 并问一次，Prepare 里另有
 * 一次 world-read。三类出生事件（actor-created / node-queued / cached node-settled）与
 * 「标记之前不带戳」在同一条脚本上同时可观察。
 */
const BIRTH_PHASE_SCRIPT = [
  "interface Answer { text: string }",
  'const solo = agent("solo");',
  'const s = await solo.ask<Answer>("before any marker");',
  'phase("Prepare");',
  'const prep = agent("prep");',
  'const p = await prep.ask<Answer>("prepare question");',
  'const paths = await files.glob("src/**/*.ts");',
  'phase("Work");',
  'const worker = agent("worker");',
  'const w = await worker.ask<Answer>("work question");',
  "return `${s.text}|${p.text}|${w.text}|${paths.length}`;",
].join("\n");

/**
 * 出生事件上的阶段坐标：把 `actor-created` / `node-queued` / `node-settled` 压成
 * (类型, 实例, 戳) 三元组。`phaseName` **缺席**与「值为 undefined」在这里是两件事——引擎只在
 * 出生事件上打戳，其余事件必须一个键都不带——所以按 in 判断条件展开，断言侧用 toStrictEqual。
 */
function birthStamps(harness: Harness): { type: string; ref: string; phaseName?: string }[] {
  return harness.runEvents
    .filter(
      (event) =>
        event.eventType === "actor-created" ||
        event.eventType === "node-queued" ||
        event.eventType === "node-settled",
    )
    .map((event) => {
      const payload = event.payload as {
        actor?: { siteId: string; ordinal: number };
        instance?: { siteId: string; ordinal: number };
        phaseName?: string;
      };
      // instance 优先：node-* 的载荷两个键都有，出生的是 instance 那个。
      const ref = payload.instance ?? payload.actor;
      return {
        type: `${event.eventType}${event.payload.cached === true ? "(cached)" : ""}`,
        ref: `${ref?.siteId}@${ref?.ordinal}`,
        ...("phaseName" in payload ? { phaseName: payload.phaseName } : {}),
      };
    });
}

/** 载荷点名的实例键（`instance` 优先，没有就取 `actor`）。 */
function refOfPayload(payload: Record<string, unknown>): string {
  const ref = (payload.instance ?? payload.actor) as
    | { siteId: string; ordinal: number }
    | undefined;
  return `${ref?.siteId}@${ref?.ordinal}`;
}

/** 归约后的实例 → 阶段坐标（缺席即 undefined）。 */
function reducedPhaseNames(state: WorkflowRunsState | undefined): {
  actors: [string, string | undefined][];
  nodes: [string, string | undefined][];
} {
  const run = state?.runs[0];
  return {
    actors: (run?.actors ?? []).map((actor) => [
      `${actor.siteId}@${actor.ordinal}`,
      actor.phaseName,
    ]),
    nodes: (run?.nodes ?? []).map((node) => [`${node.siteId}@${node.ordinal}`, node.phaseName]),
  };
}

/** 事件流逐条归约（每个用例都要走一遍完整的进度管线）。 */
function reduceAll(harness: Harness): WorkflowRunsState | undefined {
  let state: WorkflowRunsState | undefined;
  for (const event of harness.runEvents) {
    state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
  }
  return state;
}

/**
 * 运行时实例带阶段坐标的接缝（追记 2026-09-09）：引擎在**出生事件**上打的 `phaseName` 经
 * `toProgressPayload` 原样过境，再由共享 reducer 落到 `actors[*]` / `nodes[*]` 上。
 *
 * 这条接缝正是「所有子代理出现在所有阶段」那个 bug 的修复面：静态图按阶段拷贝站点，运行时
 * 实例必须带同一个坐标，UI 才能按 (站点, 阶段) 而不是按车道绑定。
 */
describe("dynamic workflow run service · 出生阶段（phaseName）", () => {
  it("标记前出生的实例不带戳、Prepare / Work 各带各的；派发与 live 结算不带，且归约后落到 actors / nodes 上", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: BIRTH_PHASE_SCRIPT,
      trace: traceFor("birth-phase"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)).toMatchObject({ status: "completed" });

    // 出生事件：标记之前的一个键都不带；标记之后的按**出生时**所在阶段带。
    // live 的 node-settled 不是出生事件，因此同样不带（戳靠 reducer 从 queued 向前携带）。
    expect(birthStamps(harness)).toStrictEqual([
      { type: "actor-created", ref: "actor#1@1" },
      { type: "node-queued", ref: "ask#1@1" },
      { type: "node-settled", ref: "ask#1@1" },
      { type: "actor-created", ref: "actor#2@1", phaseName: "Prepare" },
      { type: "node-queued", ref: "ask#2@1", phaseName: "Prepare" },
      { type: "node-settled", ref: "ask#2@1" },
      { type: "node-queued", ref: "world-read#1@1", phaseName: "Prepare" },
      { type: "node-settled", ref: "world-read#1@1" },
      { type: "actor-created", ref: "actor#3@1", phaseName: "Work" },
      { type: "node-queued", ref: "ask#3@1", phaseName: "Work" },
      { type: "node-settled", ref: "ask#3@1" },
    ]);

    // ask 的 node-dispatched 重复自己的出生事实（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
    // 「Events」）：戳与它的 node-queued 同源，标记之前出生的那个照样一个键都不带；
    // world-read 的派发始终是裸的。
    const dispatched = harness.runEvents.filter((event) => event.eventType === "node-dispatched");
    expect(
      dispatched.map((event) => ({
        ref: refOfPayload(event.payload),
        ...("phaseName" in event.payload ? { phaseName: event.payload.phaseName } : {}),
        ...("actorPhaseName" in event.payload
          ? { actorPhaseName: event.payload.actorPhaseName }
          : {}),
      })),
    ).toStrictEqual([
      { ref: "ask#1@1" },
      { ref: "ask#2@1", phaseName: "Prepare", actorPhaseName: "Prepare" },
      { ref: "world-read#1@1" },
      { ref: "ask#3@1", phaseName: "Work", actorPhaseName: "Work" },
    ]);
    // 点名子代理的事件都带上会话 id：读面据这一条就能把一个开跑的实例连同它的子代理收进表。
    const askDispatch = dispatched.find((event) => refOfPayload(event.payload) === "ask#3@1");
    expect(askDispatch).toMatchObject({
      actorSessionId: expect.any(String),
      payload: { kind: "ask", actorName: "worker", instructionsHead: "work question" },
    });
    expect(askDispatch?.actorSessionId).toBe(
      harness.runEvents.find(
        (event) =>
          event.eventType === "actor-created" && refOfPayload(event.payload) === "actor#3@1",
      )?.actorSessionId,
    );
    // world-read 的那条没有 actor，也就没有转录可开。
    expect(
      dispatched.find((event) => refOfPayload(event.payload) === "world-read#1@1"),
    ).not.toHaveProperty("actorSessionId");

    // 归约面：actor 从 actor-created 取；节点从 node-queued 取并在 dispatched / settled 上携带。
    const state = reduceAll(harness);
    expect(reducedPhaseNames(state)).toEqual({
      actors: [
        ["actor#1@1", undefined],
        ["actor#2@1", "Prepare"],
        ["actor#3@1", "Work"],
      ],
      nodes: [
        ["ask#1@1", undefined],
        ["ask#2@1", "Prepare"],
        ["world-read#1@1", "Prepare"],
        ["ask#3@1", "Work"],
      ],
    });
    // 节点确实走完了整条生命周期（否则上面的「携带」只是恰好没被覆盖）。
    expect(state?.runs[0]?.nodes.every((node) => node.phase === "settled")).toBe(true);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("resume 时 cached 的 node-settled 带回与前一世相同的出生阶段", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-birth-phase-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // —— 前驱：三个 ask 与 world-read 都 live 跑一遍，边界真的落库（resume 的门槛）。
      const before = makeHarness({ journal, sessionStore: store as never });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: BIRTH_PHASE_SCRIPT,
        trace: traceFor("birth-phase-predecessor"),
      });
      await settle(before, runA);
      expect(before.journal.getRun(runA)).toMatchObject({ status: "completed" });

      // —— 续跑：脚本逐字节相同，于是每个节点都命中导入缓存，一次真派发都没有。
      const after = makeHarness({ journal, sessionStore: store as never });
      const submitted = await after.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: BIRTH_PHASE_SCRIPT,
        trace: traceFor("birth-phase-resume"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      await settle(after, submitted.runId);
      expect(turnCount(after)).toBe(0);

      // 命中的节点没有 queued，那条 cached settle 就是它的出生事件——戳与前一世逐个相同，
      // 因为脚本重跑前缀时 phase() 沿同一轨迹重走，每个铸造点上的 currentPhase 不变。
      expect(birthStamps(after)).toStrictEqual([
        { type: "actor-created", ref: "actor#1@1" },
        { type: "node-settled(cached)", ref: "ask#1@1" },
        { type: "actor-created", ref: "actor#2@1", phaseName: "Prepare" },
        { type: "node-settled(cached)", ref: "ask#2@1", phaseName: "Prepare" },
        { type: "node-settled(cached)", ref: "world-read#1@1", phaseName: "Prepare" },
        { type: "actor-created", ref: "actor#3@1", phaseName: "Work" },
        { type: "node-settled(cached)", ref: "ask#3@1", phaseName: "Work" },
      ]);

      const state = reduceAll(after);
      expect(reducedPhaseNames(state)).toEqual({
        actors: [
          ["actor#1@1", undefined],
          ["actor#2@1", "Prepare"],
          ["actor#3@1", "Work"],
        ],
        nodes: [
          ["ask#1@1", undefined],
          ["ask#2@1", "Prepare"],
          ["world-read#1@1", "Prepare"],
          ["ask#3@1", "Work"],
        ],
      });
      expect(workflowRunsStateSchema.parse(state)).toEqual(state);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("dynamic workflow run service — 模型侧错误的收容（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
  const PARALLEL_SCRIPT = [
    "interface Answer { text: string }",
    'const alpha = agent("alpha");',
    'const beta = agent("beta");',
    "const [a, b] = await Promise.all([",
    '  alpha.ask<Answer>("first"),',
    '  beta.ask<Answer>("second"),',
    "]);",
    "return a.text + b.text;",
  ].join("\n");

  const adapterError = (context: Record<string, unknown>, message: string) =>
    Object.assign(new Error(message), {
      name: "AiSdkModelAdapterError",
      code: "model_request_failed",
      context,
    });

  it("一个子代理撞上确定性模型错误 → run stopped(provider)，兄弟在飞 ask 被 abort，可恢复", async () => {
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          {
            kind: "throw",
            error: adapterError(
              {
                reason: "auth_failed",
                providerId: "prov",
                modelId: "alpha",
                providerCode: "1006",
                retryable: false,
              },
              "[1006] token expired",
            ),
          },
        ],
        "actor#2@1": [{ kind: "hang" }],
      },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: PARALLEL_SCRIPT,
      trace: traceFor("provider-stop"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("stopped");
    expect(record?.stopReason).toBe("provider");
    expect(record?.failure?.code).toBe("ProviderStop");
    expect(record?.failure?.providerStop).toMatchObject({
      kind: "auth",
      reason: "auth_failed",
      providerCode: "1006",
      subagent: "actor#1@1",
      subagentName: "alpha",
      rawMessage: "[1006] token expired",
    });
    // 节点：触发者与兄弟都以 node-settled(cancelled) 收场（与 cancel 同），没有 failed 节点；
    // journal 的节点行保持 running（与 cancel 同：resume 时重新派发）。
    const settledNodes = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "node-settled",
    );
    expect(settledNodes.map((event) => event.payload.outcome)).toEqual(["cancelled", "cancelled"]);
    const nodes = harness.journal
      .listNodes(runId, { kinds: "all", withResult: true })
      .filter((node) => node.kind === "ask");
    expect(nodes.map((node) => node.status)).toEqual(["running", "running"]);

    // 快照：追踪器词汇 cancelled，真实词 stopped(provider) + 结构化失败。
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("provider");
    expect(snapshot?.failure?.code).toBe("ProviderStop");
    expect(snapshot?.failure?.providerStop?.kind).toBe("auth");

    // run-settled 载荷：resumable + stopReason 随事件透出（UI 的 Resume 控件与原因行读它）。
    const settled = harness.runEvents.find((event) => event.eventType === "run-settled");
    expect(settled?.payload).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      resumable: true,
      error: { code: "ProviderStop" },
    });
    expect((await harness.service.listRunsForSession?.())?.[0]).toMatchObject({
      runId,
      status: "stopped",
      stopReason: "provider",
      failureCode: "ProviderStop",
      resumable: true,
    });
  });

  it('cancel(runId, "model")（TaskStop）→ stopped(model)；缺省 initiator 是 user', async () => {
    const harness = makeHarness({ hangActors: true });
    const byModel = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("stop-by-model"),
    });
    expect(await harness.service.cancel(byModel, "model")).toBe(true);
    await settle(harness, byModel);
    expect(harness.journal.getRun(byModel)).toMatchObject({
      status: "stopped",
      stopReason: "model",
    });
    expect((await harness.service.getTask(byModel))?.stopReason).toBe("model");
    const settled = harness.runEvents.find(
      (event) => event.runId === byModel && event.eventType === "run-settled",
    );
    expect(settled?.payload).toMatchObject({
      status: "stopped",
      stopReason: "model",
      resumable: true,
    });

    const byUser = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("stop-by-user"),
    });
    expect(await harness.service.cancel(byUser)).toBe(true);
    await settle(harness, byUser);
    expect(harness.journal.getRun(byUser)).toMatchObject({ status: "stopped", stopReason: "user" });
  });
});

/**
 * 完成卡的时长口径（docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）：
 * 快照在终态携带整条 lineage 的活动时长，终态之前不带。
 *
 * 求和规则本身在 `dynamic-workflow-run-elapsed.test.ts` 里单测，每一世的 SQL 在
 * `adapters/tests/dwf-journal-store.test.ts` 里对真库钉住；这里钉的是**接线**——读面在场时那个数
 * 真的走到了快照上（终态通知只读快照），以及读面缺席时字段整个不出。
 */
class LifeSpanJournalStore extends SweepableJournalStore {
  /** 每个 run 的世；缺席即「这个 run 没有可读的世」。 */
  readonly lifeSpans = new Map<string, DwfRunLifeSpan[]>();

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return this.lifeSpans.get(runId) ?? [];
  }
}

describe("dynamic workflow run service — 快照上的 lineage 活动时长", () => {
  it("终态快照带 activeDurationMs（逐世求和），运行中不带", async () => {
    const journal = new LifeSpanJournalStore();
    const harness = makeHarness({ hangActors: true, journal });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-terminal"),
    });
    // 两世：第一世跑了一小时被打断，这一世（重放）两分钟。世与世之间的死时间不计。
    journal.lifeSpans.set(runId, [
      { startedAt: 0, lastActivityAt: 3_600_000 },
      { startedAt: 200_000_000, lastActivityAt: 200_120_000 },
    ]);

    // 运行中：与 reports / artifacts 同一道终态闸门——快照被后台追踪器反复轮询，
    // 而这个数的唯一消费者是终态通知。
    const running = await harness.service.getTask(runId);
    expect(running?.status).toBe("running");
    expect(running?.activeDurationMs).toBeUndefined();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.activeDurationMs).toBe(3_600_000 + 120_000);
  });

  it("修订链：快照报的是整条 lineage 的活动时长，不只是这一次修订的那一世", async () => {
    // 挂住 actor：前驱没有已完结的 ask，预检因此不要求消息边界（与本文件其余 amend 用例同款）。
    const journal = new LifeSpanJournalStore();
    const harness = makeHarness({ hangActors: true, journal });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-predecessor"),
    });
    // 前驱跑了四小时。
    journal.lifeSpans.set(predecessor, [{ startedAt: 0, lastActivityAt: 4 * 3_600_000 }]);

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-amendment"),
    });
    // 修订出来的这一世几乎全是缓存重放：12 秒。
    journal.lifeSpans.set(amended.runId, [
      { startedAt: 10 * 3_600_000, lastActivityAt: 10 * 3_600_000 + 12_000 },
    ]);
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // 缺陷原因：只报这一世 → 四小时的活在完成卡上写成 12 秒，而同卡 tokens 是 lineage 总数。
    expect(journal.getRun(amended.runId)?.resumedFrom).toBe(predecessor);
    expect((await harness.service.getTask(amended.runId))?.activeDurationMs).toBe(
      4 * 3_600_000 + 12_000,
    );
    // 前驱自己的卡不受影响（它被 supersede 停下，也是终态）。
    expect((await harness.service.getTask(predecessor))?.activeDurationMs).toBe(4 * 3_600_000);
  });

  it("journal 没有这条读面（引擎的内存实现）：字段整个缺席，通知退回本世", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-absent"),
    });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.activeDurationMs).toBeUndefined();
    expect("activeDurationMs" in (snapshot ?? {})).toBe(false);
  });
});

describe("dynamic workflow run service — 留白（FillWorkflowHole）", () => {
  /** 一处开放的留白，prompt 带着前一步的值；阶段表 ["准备", "裁决"]，留白按名字站在第 1 位。 */
  const HOLE_SCRIPT = [
    'phase("准备");',
    'const a = await agent("worker").ask<{ text: string }>("do the thing");',
    'const v = await hole<string>("裁决", `decide on ${a.text}`);',
    "return v;",
  ].join("\n");
  const HOLE_PHASES = ["准备", "裁决"];
  // 留白 id 是名字键（docs/analysis.md「Sites」）：按名字取，不写死哈希。
  const VERDICT = holeSiteId("裁决");
  const LEFT = holeSiteId("左");
  const RIGHT = holeSiteId("右");
  const DECIDE = holeSiteId("决定");
  const REFINE = holeSiteId("细化");

  /** 提交并等到 run 停在留白处（`hole-reached` 进度事件到达即停驻已成立：引擎先停驻再记事件）。 */
  async function submitAndReachHole(
    harness: Harness,
    name: string,
    extra: Partial<Parameters<Harness["service"]["submit"]>[0]> = {},
  ): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      phaseNames: HOLE_PHASES,
      scriptText: HOLE_SCRIPT,
      trace: traceFor(name),
      ...extra,
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.some(
          (event) => event.runId === runId && event.eventType === "hole-reached",
        ),
      ).toBe(true);
    });
    return runId;
  }

  function fill(harness: Harness, runId: string, body: string, holeId = VERDICT) {
    return harness.service.fillHole!({
      runId,
      holeId,
      body,
      parentSessionId: HARNESS_PARENT_SESSION,
      trace: traceFor("fill"),
    });
  }

  it("停在留白处：run-launched 的 holes 下标、快照的 waiting 条目、hole-reached 载荷的 type / reachedAt", async () => {
    // 真库：详情面（getRunDetail）只在带内省查询的 journal 上装，且 `updateRunScript` 的 SQLite
    // 实现在这里跟着整条链路走一遍。
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitAndReachHole(harness, "hole-wait");

      // 声明阶段表里第 1 位是开放的留白（按名字对出）。
      const launched = harness.journal.listEvents(runId, {
        types: ["run-launched"],
        reportItems: { limit: 0 },
      })[0]?.event;
      expect(launched).toMatchObject({ type: "run-launched", phaseNames: HOLE_PHASES, holes: [1] });

      // 进度载荷：类型来自编译产物，到达时刻来自 journal 的戳；prompt 带着上一步的值。
      const reached = harness.runEvents.find((event) => event.eventType === "hole-reached");
      expect(reached?.payload).toMatchObject({
        instance: { siteId: VERDICT, ordinal: 1 },
        name: "裁决",
        prompt: "decide on done",
        type: "string",
      });
      expect(typeof reached?.payload.reachedAt).toBe("number");

      // 快照：waiting 只因为引擎的停驻表里有它；line 是调用在草稿里的行，before 是前一个阶段。
      const waiting = await harness.service.getTask(runId);
      expect(waiting?.status).toBe("running");
      expect(waiting?.holes).toEqual([
        {
          siteId: VERDICT,
          ordinal: 1,
          name: "裁决",
          type: "string",
          state: "waiting",
          since: reached?.payload.reachedAt,
          line: 3,
          before: "准备",
        },
      ]);
      // 详情面同源同投影。
      const detail = await harness.service.getRunDetail?.(runId);
      expect(detail?.holes).toEqual(waiting?.holes);

      const result = await fill(harness, runId, 'return "verdict";');
      expect(result).toMatchObject({ ok: true, phasesAdded: [] });
      if (!result.ok) throw new Error(result.message);
      expect(result.scriptText).toContain(
        'hole<string>("裁决", `decide on ${a.text}`, async () => {',
      );
      expect(result.scriptText).toContain('  return "verdict";\n})');

      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("verdict");
      // 补全后：filled 来自 hole-filled 事件，带补全它的会话。函数体没有站点也没有阶段标记，但留白
      // 自己的阶段靠 mark 节点留在有效脚本的阶段表里（analysis.md「Sites」），所以仍念得出前邻居。
      expect(done?.holes).toEqual([
        {
          before: "准备",
          siteId: VERDICT,
          ordinal: 1,
          name: "裁决",
          type: "string",
          state: "filled",
          filledAt: expect.any(Number),
          filledBy: HARNESS_PARENT_SESSION,
          line: 3,
        },
      ]);
      // run 行上是有效脚本，两列同一笔（哈希对文本），getScript 给的也是它。
      const record = harness.journal.getRun(runId);
      expect(record?.scriptText).toBe(result.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(result.scriptText, "utf8").digest("hex"),
      );
      expect(await harness.service.getScript(runId)).toBe(result.scriptText);
      // hole-filled 与 phase-entered 一样原样转发，带有效脚本的阶段表。
      const filledEvent = harness.runEvents.find((event) => event.eventType === "hole-filled");
      expect(filledEvent?.payload).toMatchObject({
        siteId: VERDICT,
        filledBy: HARNESS_PARENT_SESSION,
        // 无站点、无标记的补全：留白自己的阶段仍在表里（analysis.md「Sites」）。
        phaseNames: ["准备", "裁决"],
      });
    });
  });

  it("函数体可以带阶段与子代理：新站点带留白自己的一层前缀，phasesAdded 列出函数体的阶段", async () => {
    const harness = makeHarness({
      actorScripts: { [`${VERDICT}/actor#1@1`]: [{ kind: "submit", result: { text: "judged" } }] },
    });
    const runId = await submitAndReachHole(harness, "hole-body-phases");
    const result = await fill(
      harness,
      runId,
      [
        'phase("复核");',
        'const j = await agent("judge").ask<{ text: string }>("judge it");',
        "return j.text;",
      ].join("\n"),
    );
    expect(result).toMatchObject({ ok: true, phasesAdded: ["复核"] });
    await settle(harness, runId);
    const done = await harness.service.getTask(runId);
    expect(done?.output).toBe("judged");
    expect(
      harness.runEvents.find((event) => event.eventType === "actor-created")?.payload,
    ).toMatchObject({ actor: { siteId: "actor#1", ordinal: 1 } });
    expect(
      harness.runEvents
        .filter((event) => event.eventType === "actor-created")
        .map((event) => (event.payload.actor as { siteId: string }).siteId),
    ).toEqual(["actor#1", `${VERDICT}/actor#1`]);
    expect(
      harness.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
      // 函数体以 `phase("复核")` 开头：留白自己的阶段没有成员，但仍留在表里（analysis.md「Sites」）。
      // 修复原因：它曾被丢掉，接龙的每一步名字因此从侧栏与 phaseNames 消失。
    ).toMatchObject({ phaseNames: ["准备", "裁决", "复核"] });
  });

  it("函数体里可以跑种子脚本没有的命令：world.run 的授权只在编译期，driver 没有第二份名单", async () => {
    // 回归：driver 曾持有 launch 时从种子脚本收集的 declaredRunCommands，补全编译的是有效脚本、
    // driver 手里却还是种子那份，函数体里第一次出现的 `world.run("echo", …)` 被当"接线错误"拒掉，
    // 整个 run 因此失败（workflow-world-read.ts 文件头第 2 条；authoring.md「Running commands」）。
    const ran: string[] = [];
    const stream = (text: string) => ({
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    });
    const executionPort: ExecutionPort = {
      run: async (request) => {
        ran.push(request.command.mode === "argv" ? request.command.file : request.command.command);
        return {
          status: "completed",
          exitCode: 0,
          stdout: stream("hi\n"),
          stderr: stream(""),
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(0),
          completedAt: new Date(1),
        } as never;
      },
    };
    const harness = makeHarness({ executionPort });
    const runId = await submitAndReachHole(harness, "hole-body-new-command");
    const result = await fill(
      harness,
      runId,
      ['const r = await world.run("echo", ["hi"]);', "return r.stdout.trim();"].join("\n"),
    );
    expect(result).toMatchObject({ ok: true });
    await settle(harness, runId);
    const done = await harness.service.getTask(runId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("hi");
    expect(ran).toEqual(["echo"]);
  });

  it("编不过的函数体是拒绝：诊断落在函数体坐标上，什么都没写，留白照旧在等", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-diagnostics");
    const before = harness.journal.getRun(runId)?.scriptText;
    const refused = await fill(
      harness,
      runId,
      ['const x: number = "no";', 'return "v";'].join("\n"),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected compile_failed");
    expect(refused.reason).toBe("compile_failed");
    expect(refused.diagnostics).toEqual([
      // 分析器把 2322 锚在声明名 `x` 上（第 7 列），拼接垫的缩进已经扣掉。
      expect.objectContaining({ inFill: true, line: 1, column: 7, code: 2322 }),
    ]);
    expect(harness.journal.getRun(runId)?.scriptText).toBe(before);
    expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
    expect(harness.runEvents.some((event) => event.eventType === "hole-filled")).toBe(false);

    // 改好再交：同一处留白照常接受。
    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    await settle(harness, runId);
  });

  describe("函数体点名的模型只能取本 run 的绑定表（MR !2837 评审 CR-01）", () => {
    const LIGHT: ModelSelection = { providerId: "zhipu", modelId: "GLM-5.3-Flash" };
    const judgeBody = (name: string) =>
      [
        `const j = await agent("judge", { model: model(${JSON.stringify(name)}) }).ask<{ text: string }>("judge it");`,
        "return j.text;",
      ].join("\n");

    it("表外的名字是 9011 拒绝：落在函数体坐标上，什么都没写，留白照旧在等", async () => {
      const harness = makeHarness();
      const runId = await submitAndReachHole(harness, "hole-model-unbound", {
        modelBindings: { "GLM-5.3-Flash": LIGHT },
      });
      const before = harness.journal.getRun(runId)?.scriptText;
      const refused = await fill(harness, runId, judgeBody("GLM-5.3$high"));
      if (refused.ok) throw new Error("expected compile_failed");
      expect(refused.reason).toBe("compile_failed");
      expect(refused.diagnostics).toEqual([
        expect.objectContaining({ inFill: true, line: 1, code: 9011 }),
      ]);
      expect(refused.diagnostics?.[0]?.message).toContain('"GLM-5.3$high"');
      expect(refused.diagnostics?.[0]?.message).toContain('"GLM-5.3-Flash" = zhipu/GLM-5.3-Flash');
      expect(harness.journal.getRun(runId)?.scriptText).toBe(before);
      expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
      expect(harness.runEvents.some((event) => event.eventType === "hole-filled")).toBe(false);
      expect(harness.actorRuntimeInputs.some((input) => "actorModel" in input)).toBe(false);
    });

    it("run 没点名过任何模型时，函数体点名模型同样被拒", async () => {
      const harness = makeHarness();
      const runId = await submitAndReachHole(harness, "hole-model-no-table");
      const refused = await fill(harness, runId, judgeBody("GLM-5.3-Flash"));
      if (refused.ok) throw new Error("expected compile_failed");
      expect(refused.diagnostics).toEqual([expect.objectContaining({ inFill: true, code: 9011 })]);
      expect(refused.diagnostics?.[0]?.message).toContain("without naming any model");
      expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
    });

    it("表里的名字照常接受，子代理跑在绑定的模型上", async () => {
      const harness = makeHarness({
        actorScripts: {
          [`${VERDICT}/actor#1@1`]: [{ kind: "submit", result: { text: "judged" } }],
        },
      });
      const runId = await submitAndReachHole(harness, "hole-model-bound", {
        modelBindings: { "GLM-5.3-Flash": LIGHT },
      });
      expect(await fill(harness, runId, judgeBody("GLM-5.3-Flash"))).toMatchObject({ ok: true });
      await settle(harness, runId);
      expect((await harness.service.getTask(runId))?.output).toBe("judged");
      const judge = harness.actorRuntimeInputs.find(
        (input) => refToString(input.actor) === `${VERDICT}/actor#1@1`,
      );
      expect(judge?.actorModel).toEqual(LIGHT);
    });
  });

  it("不在等的种种：未知 run、未知留白、还没到达、已补过、已停下（指向 ResumeWorkflowRun）", async () => {
    expect(await fill(makeHarness(), "dwfrun-nope", "return 1;")).toMatchObject({
      ok: false,
      reason: "run_not_found",
    });

    // 还没到达：子代理挂着，脚本停在留白之前的 ask 上。
    const hanging = makeHarness({ hangActors: true });
    const pending = await submitRun(hanging, {
      cwd: TEST_CWD,
      phaseNames: HOLE_PHASES,
      scriptText: HOLE_SCRIPT,
      trace: traceFor("hole-not-reached"),
    });
    await vi.waitFor(() => {
      expect(hanging.runEvents.some((event) => event.eventType === "node-dispatched")).toBe(true);
    });
    const notReached = await fill(hanging, pending, 'return "v";');
    expect(notReached).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    expect((await hanging.service.getTask(pending))?.holes).toBeUndefined();
    await hanging.service.cancel(pending);
    await settle(hanging, pending);

    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-refusals");
    const unknownHole = await fill(harness, runId, "return 1;", "hole#9");
    expect(unknownHole).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (unknownHole.ok) throw new Error("unreachable");
    expect(unknownHole.message).toContain("hole#9");

    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    const again = await fill(harness, runId, 'return "w";');
    expect(again).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (again.ok) throw new Error("unreachable");
    expect(again.message).toContain("already filled");
    await settle(harness, runId);

    // 在留白处停下的 run：停驻的分支随取消撤下，补全指向 resume。
    const stopped = makeHarness();
    const stoppedRun = await submitAndReachHole(stopped, "hole-stopped");
    await stopped.service.cancel(stoppedRun);
    await settle(stopped, stoppedRun);
    expect((await stopped.service.getTask(stoppedRun))?.status).toBe("cancelled");
    const afterStop = await fill(stopped, stoppedRun, 'return "v";');
    expect(afterStop).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (afterStop.ok) throw new Error("unreachable");
    expect(afterStop.message).toContain("ResumeWorkflowRun");
    // 死掉的停驻不报 waiting：没有引擎在等，快照上这处留白整个不出。
    expect((await stopped.service.getTask(stoppedRun))?.holes).toBeUndefined();
  });

  it("草稿就地改写成有效脚本、路径不变；没有草稿的 run 由注入的铸造器补一份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwf-hole-draft-"));
    const draftPath = join(dir, "裁决.dwf.ts");
    await writeFile(draftPath, HOLE_SCRIPT, "utf8");
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-draft", { scriptPath: draftPath });
    const result = await fill(harness, runId, 'return "v";');
    if (!result.ok) throw new Error(result.message);
    expect(result.scriptPath).toBe(draftPath);
    expect(await readFile(draftPath, "utf8")).toBe(result.scriptText);
    expect((await harness.service.getTask(runId))?.scriptPath).toBe(draftPath);
    await settle(harness, runId);

    // 没有草稿的 run：铸造器先于引擎落盘，路径随 hole-filled 进 journal，冷读面重启后照样找得到。
    await withSqliteJournal(async (journal) => {
      const minted: { cwd: string; name: string; source: string }[] = [];
      const mintPath = join(dir, "minted.dwf.ts");
      const minting = makeHarness({
        journal,
        writeWorkflowDraft: async (input) => {
          minted.push(input);
          return { path: mintPath };
        },
      });
      const draftless = await submitAndReachHole(minting, "hole-mint", { name: "夜间审阅" });
      const mintedResult = await fill(minting, draftless, 'return "v";');
      if (!mintedResult.ok) throw new Error(mintedResult.message);
      expect(mintedResult.scriptPath).toBe(mintPath);
      expect(minted).toEqual([
        { cwd: TEST_CWD, name: "夜间审阅", source: mintedResult.scriptText },
      ]);
      expect((await minting.service.getTask(draftless))?.scriptPath).toBe(mintPath);
      expect(
        minting.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
      ).toMatchObject({ siteId: VERDICT, scriptPath: mintPath });
      await settle(minting, draftless);
      // 冷读：另一个 service 实例（没有条目）从 journal 事件读回补全铸的那份，而不是 run-launched
      // 上的缺席。
      const cold = makeHarness({ journal });
      expect((await cold.service.getTask(draftless))?.scriptPath).toBe(mintPath);
      expect((await cold.service.getRunDetail?.(draftless))?.scriptPath).toBe(mintPath);
    });
    await rm(dir, { recursive: true, force: true });
  });

  /** 两个 future 各停在一处留白：两处可以同时在等，模型也会把两次补全放进同一个并行批里。 */
  const TWO_HOLES_SCRIPT = [
    'phase("准备");',
    "const left = future(async () => {",
    '  const a = await agent("l").ask<{ text: string }>("left");',
    '  return await hole<string>("左", `l ${a.text}`);',
    "});",
    "const right = future(async () => {",
    '  const b = await agent("r").ask<{ text: string }>("right");',
    '  return await hole<string>("右", `r ${b.text}`);',
    "});",
    "const [x, y] = await Promise.all([left, right]);",
    'return x + "+" + y;',
  ].join("\n");

  async function submitAndReachBothHoles(harness: Harness, name: string): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      phaseNames: ["准备", "左", "右"],
      scriptText: TWO_HOLES_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.filter(
          (event) => event.runId === runId && event.eventType === "hole-reached",
        ),
      ).toHaveLength(2);
    });
    return runId;
  }

  it("同一个 run 的两次并发补全串行执行：journal 的有效脚本同时带着两个函数体，两个分支都完成", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitAndReachBothHoles(harness, "hole-concurrent");
      expect((await harness.service.getTask(runId))?.holes?.map((hole) => hole.state)).toEqual([
        "waiting",
        "waiting",
      ]);
      const [first, second] = await Promise.all([
        fill(harness, runId, 'return "L";', LEFT),
        fill(harness, runId, 'return "R";', RIGHT),
      ]);
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      if (!second.ok || !first.ok) throw new Error("unreachable");
      // 第二次是在第一次的有效脚本上拼的：它交出的文本包含两个函数体，journal 行就是它。
      expect(second.scriptText).toContain('hole<string>("左", `l ${a.text}`, async () => {');
      expect(second.scriptText).toContain('hole<string>("右", `r ${b.text}`, async () => {');
      expect(second.scriptText).toContain('return "L";');
      expect(second.scriptText).toContain('return "R";');
      const record = journal.getRun(runId);
      expect(record?.scriptText).toBe(second.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(second.scriptText, "utf8").digest("hex"),
      );
      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("L+R");
      expect(done?.holes?.map((hole) => [hole.siteId, hole.state])).toEqual([
        [LEFT, "filled"],
        [RIGHT, "filled"],
      ]);
      expect(
        harness.runEvents
          .filter((event) => event.eventType === "hole-filled")
          .map((event) => event.payload.siteId),
      ).toEqual([LEFT, RIGHT]);
    });
  });

  it("被拒绝的第一次补全不阻塞排在它后面的第二次", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachBothHoles(harness, "hole-refused-first");
    const [refused, accepted] = await Promise.all([
      // `hole<string>` 的体返回 number：编译期拒绝。
      fill(harness, runId, "return 1;", LEFT),
      fill(harness, runId, 'return "R";', RIGHT),
    ]);
    expect(refused).toMatchObject({ ok: false, reason: "compile_failed" });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) throw new Error("unreachable");
    expect(accepted.scriptText).not.toContain("return 1;");
    expect(accepted.scriptText).toContain('return "R";');
    expect(
      (await harness.service.getTask(runId))?.holes?.map((hole) => [hole.siteId, hole.state]),
    ).toEqual([
      [LEFT, "waiting"],
      [RIGHT, "filled"],
    ]);
    const retried = await fill(harness, runId, 'return "L";', LEFT);
    expect(retried).toMatchObject({ ok: true });
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.scriptText).toContain('return "R";');
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.output).toBe("L+R");
  });

  it("递归补全：外层函数体里再开一处留白，内层体读到外层体与留白之前的绑定；两次补全都就地改写草稿；停下后 resume 不再请求任何留白", async () => {
    const NESTED_SCRIPT = [
      "interface Plan { step: string }",
      'phase("探索");',
      'const seed = await agent("scout").ask<{ text: string }>("scout it");',
      'const plan = await hole<Plan>("决定", `plan for ${seed.text}`);',
      'phase("执行");',
      'const done = await agent("worker").ask<{ text: string }>(`execute ${plan.step}`);',
      "return done.text;",
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "dwf-hole-nested-"));
    const draftPath = join(dir, "决定.dwf.ts");
    await writeFile(draftPath, NESTED_SCRIPT, "utf8");
    // worker 的计划是一个**共享的**数组：第一世挂起（好让 run 在两次补全之后停下），resume 之前
    // 换成一次提交——重水化出来的新 runtime 拿到的是同一个数组引用。
    const workerPlan: ActorPlan[] = [{ kind: "hang-until-cancelled" }];
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        journal,
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "seed" } }],
          [`${DECIDE}/actor#1@1`]: [{ kind: "submit", result: { text: "draft" } }],
          "actor#2@1": workerPlan,
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        phaseNames: ["探索", "决定", "执行"],
        scriptPath: draftPath,
        scriptText: NESTED_SCRIPT,
        trace: traceFor("hole-nested"),
      });
      const reachedIds = () =>
        harness.runEvents
          .filter((event) => event.runId === runId && event.eventType === "hole-reached")
          .map((event) => (event.payload.instance as { siteId: string }).siteId);
      await vi.waitFor(() => expect(reachedIds()).toEqual([DECIDE]));

      // 第一次补全：体里先开一个阶段、问一次，再以内层留白的结果返回；内层留白的 prompt 读体内的 const。
      const outer = await fill(
        harness,
        runId,
        [
          'phase("初步");',
          'const draft = await agent("drafter").ask<{ text: string }>("draft it");',
          "const x = draft.text;",
          'return await hole<Plan>("细化", `refine ${x}`);',
        ].join("\n"),
        DECIDE,
      );
      if (!outer.ok) throw new Error(outer.message);
      expect(outer.phasesAdded).toEqual(["初步", "细化"]);
      expect(outer.scriptPath).toBe(draftPath);
      expect(await readFile(draftPath, "utf8")).toBe(outer.scriptText);

      // run 停在嵌套的留白处：id 是它自己的名字键（不带外层前缀），类型来自有效脚本，前后邻居是
      // 有效脚本的阶段。
      await vi.waitFor(() => expect(reachedIds()).toEqual([DECIDE, REFINE]));
      const nestedReached = harness.runEvents.find(
        (event) =>
          event.eventType === "hole-reached" &&
          reachedIds().length === 2 &&
          (event.payload.instance as { siteId: string }).siteId === REFINE,
      );
      expect(nestedReached?.payload).toMatchObject({
        name: "细化",
        prompt: "refine draft",
        type: "Plan",
        reachedAt: expect.any(Number),
      });
      const parked = await harness.service.getTask(runId);
      expect(parked?.holes).toEqual([
        expect.objectContaining({
          siteId: DECIDE,
          state: "filled",
          filledBy: HARNESS_PARENT_SESSION,
        }),
        expect.objectContaining({
          siteId: REFINE,
          ordinal: 1,
          name: "细化",
          type: "Plan",
          state: "waiting",
          before: "初步",
          after: "执行",
        }),
      ]);
      expect(
        harness.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
        // 外层留白的函数体以标记开头，它自己的阶段仍留在表里（「决定」不再从 phaseNames 消失）。
      ).toMatchObject({
        siteId: DECIDE,
        phaseNames: ["探索", "决定", "初步", "细化", "执行"],
        holes: [3],
      });

      // 第二次补全：内层体读外层体的 `x` 与外层留白之前的 `seed`；新 id 带内层留白自己的前缀。
      const inner = await fill(harness, runId, "return { step: `${seed.text}/${x}` };", REFINE);
      if (!inner.ok) throw new Error(inner.message);
      expect(inner.phasesAdded).toEqual([]);
      expect(inner.scriptPath).toBe(draftPath);
      expect(await readFile(draftPath, "utf8")).toBe(inner.scriptText);
      expect(inner.scriptText).toContain('hole<Plan>("细化", `refine ${x}`, async () => {');
      expect(inner.scriptText).toContain("return { step: `${seed.text}/${x}` };");
      // journal 的 run 行：两个函数体嵌套在有效脚本里，哈希对文本。
      const record = journal.getRun(runId);
      expect(record?.scriptText).toBe(inner.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(inner.scriptText, "utf8").digest("hex"),
      );
      expect((await harness.service.getTask(runId))?.holes?.map((hole) => hole.state)).toEqual([
        "filled",
        "filled",
      ]);

      // 内层体的值流进了外层留白之后的阶段：worker 的问句里带着 seed/draft。
      await vi.waitFor(() => {
        expect(harness.actorModelRequests["actor#2@1"]?.requests.length ?? 0).toBeGreaterThan(0);
      });
      expect(
        JSON.stringify(harness.actorModelRequests["actor#2@1"]?.requests[0]?.messages),
      ).toContain("execute seed/draft");

      // 两次补全之后停下，再 resume：有效脚本的两个函数体内联执行，一次留白请求都没有。
      await harness.service.cancel(runId);
      await settle(harness, runId);
      expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
      workerPlan.splice(0, workerPlan.length, { kind: "submit", result: { text: "shipped" } });
      const eventsBeforeResume = harness.runEvents.length;
      const resumed = await harness.service.resume(runId);
      expect(resumed).toMatchObject({ ok: true, runId });
      await settle(harness, runId);
      const secondLife = harness.runEvents.slice(eventsBeforeResume);
      expect(secondLife.some((event) => event.eventType === "hole-reached")).toBe(false);
      const finished = await harness.service.getTask(runId);
      expect(finished?.status).toBe("completed");
      expect(finished?.output).toBe("shipped");
      expect(finished?.scriptPath).toBe(draftPath);
      expect(
        JSON.stringify(harness.actorModelRequests["actor#2@1"]?.requests.at(-1)?.messages),
      ).toContain("execute seed/draft");
    });
    await rm(dir, { recursive: true, force: true });
  });

  // 修复原因：留白 id 曾逐层拼接（`hole#1/hole#1/…`，每层 7 个字符），十层的接龙里最里层的 id 就过了
  // 协议的 64 字符上界。这里在真实的 SQLite journal 上跑一条十步的尾巴留白接龙：每一步都是一次
  // FillWorkflowHole，最后一步派一个子代理并返回；每条到达事件、每个子代理、run 的留白快照里的 id
  // 都在 64 以内，且与深度无关。
  it("十步的尾巴留白接龙跑到完成：每一步一个名字键 id，深度不进 id，所有 id 都在 64 字符以内", async () => {
    const STEPS = 10;
    const stepName = (k: number) => `第${k}步`;
    const SEED = [
      'phase("起步");',
      'const seed = await agent("勘察员").ask<{ text: string }>("look");',
      `return await hole<string>("${stepName(1)}", \`from \${seed.text}\`);`,
    ].join("\n");
    const last = holeSiteId(stepName(STEPS));
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        journal,
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "seed" } }],
          [`${last}/actor#1@1`]: [{ kind: "submit", result: { text: "shipped" } }],
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        phaseNames: ["起步", stepName(1)],
        scriptText: SEED,
        trace: traceFor("hole-chain-ten"),
      });
      const reached = () =>
        harness.runEvents
          .filter((event) => event.runId === runId && event.eventType === "hole-reached")
          .map((event) => (event.payload.instance as { siteId: string }).siteId);
      for (let k = 1; k <= STEPS; k += 1) {
        const id = holeSiteId(stepName(k));
        await vi.waitFor(() => expect(reached()).toContain(id));
        const body =
          k === STEPS
            ? 'const done = await agent("收尾").ask<{ text: string }>(`finish ${seed.text}`);\nreturn done.text;'
            : `return await hole<string>("${stepName(k + 1)}", "progress ${k}");`;
        const result = await fill(harness, runId, body, id);
        if (!result.ok) throw new Error(`step ${k}: ${result.message}`);
      }
      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("shipped");

      // 每一步恰好到达一次，按接龙次序。
      expect(reached()).toEqual(
        Array.from({ length: STEPS }, (_, i) => holeSiteId(stepName(i + 1))),
      );
      // 所有进过事件的 id：到达的留白、创建的子代理，都在协议上界以内，而且最长的与深度无关。
      const actorIds = harness.runEvents
        .filter((event) => event.eventType === "actor-created")
        .map((event) => (event.payload.actor as { siteId: string }).siteId);
      expect(actorIds).toEqual(["actor#1", `${last}/actor#1`]);
      for (const id of [...reached(), ...actorIds]) expect(id.length, id).toBeLessThanOrEqual(64);
      expect(Math.max(...[...reached(), ...actorIds].map((id) => id.length))).toBe(
        `${last}/actor#1`.length,
      );
      // 快照：十个留白都补全了；有效脚本的阶段表念得出每一步的名字。
      expect(done?.holes?.map((hole) => [hole.siteId, hole.state])).toEqual(
        Array.from({ length: STEPS }, (_, i) => [holeSiteId(stepName(i + 1)), "filled"]),
      );
      const lastFilled = harness.runEvents
        .filter((event) => event.eventType === "hole-filled")
        .at(-1);
      expect(lastFilled?.payload.phaseNames).toEqual([
        "起步",
        ...Array.from({ length: STEPS }, (_, i) => stepName(i + 1)),
      ]);
    });
  });

  it("冷回放为 hole-reached 铸出与 live 逐字节相同的载荷（type 从行里的有效脚本重建）", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-replay");
    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    await settle(harness, runId);
    const live = harness.runEvents.filter(
      (event) => event.eventType === "hole-reached" || event.eventType === "hole-filled",
    );
    const row = (harness.journal as SweepableJournalStore)
      .listRunsByParentSession(HARNESS_PARENT_SESSION, 16)
      .find((item) => item.runId === runId);
    const replayed = replayRunProgress(
      row!,
      harness.journal,
      resolveWorkflowDefaultConcurrency(),
    ).filter((event) => event.eventType === "hole-reached" || event.eventType === "hole-filled");
    expect(replayed).toEqual(live);
  });
});

describe("dynamic workflow run service — 额度停止后到点自动续跑", () => {
  // apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Resuming after a quota
  // reset": a real-format 1308 raw message (no Retry-After) -> the stop record carries the reset time -> automatic resume at that time.
  const SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>("go");',
    "return a.text;",
  ].join("\n");

  /** Beijing time as "YYYY-MM-DD HH:MM:SS", the same shape as the server message. */
  const beijingText = (at: number): string => {
    const iso = new Date(at + 8 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  };

  it("原文里的重置时刻落进停止记录，到点后续跑并跑完", async () => {
    const resetAt = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000) * 1000;
    const quotaError = Object.assign(
      new Error(
        `[1308][已达到 5 小时的使用上限。您的限额将在 ${beijingText(resetAt)} 重置。][20261019120000abc]`,
      ),
      {
        name: "AiSdkModelAdapterError",
        code: "model_rate_limited",
        context: { reason: "rate_limited", providerCode: "1308", retryable: false },
      },
    );
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "throw", error: quotaError }] },
    };
    const harness = makeHarness(options);

    let now = Date.now();
    const timers: { at: number; callback: () => void }[] = [];
    const auto = startWorkflowQuotaAutoResume({
      journal: harness.journal,
      parentSessionId: HARNESS_PARENT_SESSION,
      resume: (runId) => harness.service.resume!(runId),
      subscribeRunSettled: (listener) => harness.service.subscribeRunSettled(listener),
      clock: {
        now: () => now,
        schedule: (callback, delayMs) => {
          timers.push({ at: now + delayMs, callback });
          return () => {};
        },
      },
    });
    try {
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: SCRIPT,
        trace: traceFor("quota-auto-resume"),
      });
      await settle(harness, runId);
      expect(harness.journal.getRun(runId)).toMatchObject({
        status: "stopped",
        stopReason: "provider",
        failure: { providerStop: { kind: "quota", providerCode: "1308", resetAt } },
      });
      await vi.waitFor(() => {
        expect(timers).toHaveLength(1);
      });
      expect(timers[0]!.at).toBe(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);

      // Quota is back: the subagent can answer this time. Once the clock passes the reset time, the timer triggers the resume.
      options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "after reset" } }] };
      now = timers[0]!.at;
      timers.shift()!.callback();
      await vi.waitFor(() => {
        expect(harness.journal.getRun(runId)?.status).toBe("completed");
      });
      expect((await harness.service.getTask(runId))?.output).toBe("after reset");
    } finally {
      auto.dispose();
    }
  });
});

describe("session close waits for workflow actor resources", () => {
  it.each([true, false])(
    "drains actors even when run was already terminal=%s",
    async (terminal) => {
      let finish!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let cleanupStarted = false;
      const harness = makeHarness({
        hangActors: !terminal,
        actorCleanup: async () => {
          cleanupStarted = true;
          await cleanup;
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("owned-workflow-close"),
      });
      await vi.waitFor(() => expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0));
      if (terminal) await settle(harness, runId);
      let closed = false;
      const closing = harness.service.close().then(() => {
        closed = true;
      });
      try {
        await vi.waitFor(() => expect(cleanupStarted).toBe(true));
        expect(closed).toBe(false);
        finish();
        await closing;
        expect(closed).toBe(true);
      } finally {
        finish();
        await closing;
      }
    },
  );
});

it("owner close prevents an in-flight amend from launching a successor", async () => {
  const harness = makeHarness({ hangActors: true });
  const runId = await submitRun(harness, {
    cwd: TEST_CWD,
    parentSessionId: HARNESS_PARENT_SESSION,
    scriptText: TYPED_SCRIPT,
    trace: traceFor("close-amend-race"),
  });
  await vi.waitFor(() => expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0));
  const amending = harness.service.amend!({
    cwd: TEST_CWD,
    parentSessionId: HARNESS_PARENT_SESSION,
    predecessorRunId: runId,
    scriptText: TYPED_SCRIPT,
    trace: traceFor("closing-amend"),
  });
  const rejected = expect(amending).rejects.toThrow(/closed/);
  await harness.service.close();
  await rejected;
  expect(harness.service.countLiveRuns()).toBe(0);
});
