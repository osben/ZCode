import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import { createDenyPermissionBroker } from "@zcode/core";
import type { GlobalOptions } from "@zcode/shared-types";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { readRuntimeFunction } from "./runtime-event-subscriber.js";

/**
 * CreateWorkflow approval bypass for headless (`-p`) mode.
 *
 * Why it is needed: headless never constructs a permissionBroker, so core falls back to
 * `createDenyPermissionBroker()`（`core/src/runtime/agent-runtime.ts`、
 * `core/src/tool/executor/impl.ts`), while CreateWorkflow's `alwaysAsk` gate must go through the
 * broker in every mode (`yolo` cannot skip it either; the alwaysAsk branch in
 * `core/src/permission/service.ts` precedes the mode switch). Together, this means dwf in `-p` is
 * **always rejected immediately**, with "No permission client configured for CreateWorkflow"—not
 * suspended or timed out.
 *
 * The bypass allows only CreateWorkflow by tool name; all other tools are **delegated to the same
 * deny broker**. Reusing its rejection behavior makes "all other tools retain today's behavior" a
 * structural fact rather than a coincidence (the message cannot drift because only one copy exists).
 *
 * This bypasses only the gate, not permissions: core is unchanged, the PermissionRequest hook
 * still runs before the broker responds (`??` short-circuit in `permission-flow.ts`), permission
 * events are emitted as usual, and actors in the run continue to inherit the session permission profile.
 */
export const createHeadlessPermissionBroker = (): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> => {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
      // AmendWorkflow shares the same gate and exception as CreateWorkflow.
      if (
        request.toolName !== CREATE_WORKFLOW_TOOL_NAME &&
        request.toolName !== AMEND_WORKFLOW_TOOL_NAME
      ) {
        return await denyBroker.requestPermission(request, options);
      }
      return {
        decision: "allow",
        reason: `Headless CLI auto-approves ${request.toolName}: no interactive gate exists in -p mode.`,
        resolvedAt: new Date(),
      };
    },
  };
};

/**
 * `type` of a dwf progress line in stream-json.
 *
 * Deliberately **not** included in `zcodeSessionEventTypeSchema`
 * (`shared/src/zcode-protocol/index.ts`): that closed `z.enum` feeds the discriminated union in
 * `zcodeSessionEventSchema`; adding a value would make the v3 app-server declare a type-level event
 * it never emits. stream-json is a CLI-private output format and is not constrained by the protocol's strict schema.
 */
const WORKFLOW_RUN_PROGRESS_STREAM_TYPE = "workflow.run.progress";

/**
 * One typed NDJSON line for dwf progress. Envelope fields match `mapSessionEvent` exactly (same
 * keys and the same `String()`/`getTime()` normalization), so line readers need no special envelope
 * rules for this line type. `payload` is the bounded contracts payload **as-is**, with no field renaming.
 */
interface WorkflowRunProgressStreamLine {
  type: typeof WORKFLOW_RUN_PROGRESS_STREAM_TYPE;
  eventId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  traceId: string;
  payload: DynamicWorkflowRunProgressPayload;
}

/** Is this a dwf progress session event? stream-json and stderr progress share this check. */
const isDynamicWorkflowRunProgressEvent = (event: SessionEvent): boolean =>
  event.type === SessionEventType.DynamicWorkflowRunProgress;

const progressPayloadOf = (event: SessionEvent): DynamicWorkflowRunProgressPayload =>
  event.payload as DynamicWorkflowRunProgressPayload;

/**
 * Convert a dwf progress event to a typed NDJSON line.
 *
 * This fixes the current leak: the default in `mapSessionEventType` maps this type to catch-all
 * `session.updated` (`session-mapper.ts`), so stream-json consumers receive a line named like
 * "something in the session changed" but carrying run-internal payload—indistinguishable and
 * impossible to subscribe to separately.
 *
 * Note that dwf events are **outside turns** (`turnId` is always empty), so the envelope omits
 * `turnId`; an always-undefined key would mislead readers into thinking it sometimes has a value.
 */
const mapWorkflowRunProgressStreamLine = (event: SessionEvent): WorkflowRunProgressStreamLine => ({
  type: WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  eventId: String(event.id),
  sessionId: String(event.sessionId),
  seq: event.sequenceNumber,
  timestamp: event.timestamp.getTime(),
  traceId: String(event.traceId),
  payload: progressPayloadOf(event),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const instanceLabel = (payload: Record<string, unknown>): string | undefined => {
  const instance = asRecord(payload.instance);
  const siteId = instance.siteId;
  if (typeof siteId !== "string") return undefined;
  const ordinal = instance.ordinal;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
};

/**
 * The **state-transition** subset of engine event kinds (`text` mode prints only these plus `log` to stderr).
 *
 * Vocabulary comes from the contract comment for `toProtocolEvent` (`bootstrap/src/app/dynamic-workflow-run-launch.ts`):
 * run-started / actor-created / node-queued / node-dispatched / node-repairing /
 * node-nudged / node-settled / usage-updated / log / run-settled。
 * Deliberately omit `usage-updated` and `actor-created`: the former is only a counter, and the latter is not a transition.
 */
const describeProgress = (payload: DynamicWorkflowRunProgressPayload): string | undefined => {
  const inner = asRecord(payload.payload);
  switch (payload.eventType) {
    case "run-started":
      return "started";
    case "run-settled": {
      // Terminal-state vocabulary: completed/errored/stopped;
      // stopped includes a reason: `stopped/provider: …`.
      const rawStatus = typeof inner.status === "string" ? inner.status : "settled";
      const status =
        typeof inner.stopReason === "string" ? `${rawStatus}/${inner.stopReason}` : rawStatus;
      const error = asRecord(inner.error).message;
      return typeof error === "string" ? `${status}: ${error}` : status;
    }
    case "log":
      return typeof inner.message === "string" ? `log: ${inner.message}` : undefined;
    case "node-queued":
    case "node-dispatched":
    case "node-repairing":
    case "node-nudged": {
      const label = instanceLabel(inner);
      return label ? `${payload.eventType.slice("node-".length)} ${label}` : undefined;
    }
    case "node-settled": {
      const label = instanceLabel(inner);
      const outcome = typeof inner.outcome === "string" ? inner.outcome : "settled";
      return label ? `settled ${label} (${outcome})` : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Whether a transition belongs to the **always-print** subset. Run start and settlement are the
 * two endpoints of this progress stream; throttling must not drop them, or `text` mode might print
 * nothing throughout the wait and then suddenly print the final answer. `log` is emitted explicitly
 * by the script author (`log()` facade) and is also unthrottled: the script controls its frequency,
 * and the author wrote it to be seen.
 */
const isUnthrottledProgress = (eventType: string): boolean =>
  eventType === "run-started" || eventType === "run-settled" || eventType === "log";

interface WorkflowProgressReporterInput {
  /** Write progress only to stderr; stdout belongs to the result (`text` mode prints brief progress to stderr). */
  write: (line: string) => void;
  /** Inject a clock so throttling can be exhaustively tested without sleeping. */
  now?: () => number;
  /** Minimum interval between node phase transitions; `log` and run endpoints are exempt. */
  throttleMs?: number;
}

/** Default throttle interval for node phase transitions. A 100-node run emits roughly 5×100 events. */
const DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS = 400;

/**
 * stderr progress printer for `--output-format text`.
 * Handles only dwf progress events; all other session events are ignored with no side effects.
 */
const createWorkflowProgressReporter = (
  input: WorkflowProgressReporterInput,
): ((event: SessionEvent) => void) => {
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS;
  let lastThrottledAt: number | undefined;
  return (event) => {
    if (!isDynamicWorkflowRunProgressEvent(event)) return;
    const payload = progressPayloadOf(event);
    const description = describeProgress(payload);
    if (description === undefined) return;
    if (!isUnthrottledProgress(payload.eventType)) {
      const at = now();
      if (lastThrottledAt !== undefined && at - lastThrottledAt < throttleMs) return;
      lastThrottledAt = at;
    }
    input.write(`workflow ${payload.runId}: ${description}\n`);
  };
};

interface HeadlessWriteStream {
  write: (chunk: string) => unknown;
}

interface HeadlessSessionObserverInput {
  options: Pick<GlobalOptions, "json" | "outputFormat">;
  stderr: HeadlessWriteStream;
  stdout: HeadlessWriteStream;
  /** Needed only for `--output-format stream-json`; when absent, do not write NDJSON. */
  mapSessionEvent?: (event: SessionEvent) => unknown;
}

interface HeadlessSessionObserver {
  /** The sole session-event consumer. Attach it to **one** sink; two sinks would write each line twice. */
  observe: (event: SessionEvent) => void;
  /**
   * Has dwf activity been observed? This is the **narrow trigger** for waiting for settlement:
   * runs without dwf activity never wait and behave byte-for-byte as before.
   */
  hasWorkflowActivity: () => boolean;
  /**
   * Start recording turn text. Call **synchronously** after `submitPrompt` returns: no event can
   * interleave before the first await, so the first event of a notification-driven turn cannot be missed.
   * `excludeTurnId` is the first turn's ID; its text came from `submitPrompt`'s return value, and
   * this ID prevents double-counting if its `turn_complete` arrives late.
   */
  beginWaitPhase: (excludeTurnId?: string) => void;
  /** Text from each completed turn during the wait, ordered by arrival. */
  waitPhaseTurnResponses: () => readonly string[];
}

/**
 * Headless session-event observer: centralizes what each output format must do and what the wait needs to know.
 *
 * Responsibilities of the three formats:
 *   stream-json -> one NDJSON line per event on stdout; dwf progress uses typed lines, with no duplicate stderr output.
 *   text        -> dwf progress only, sent only to stderr (stdout belongs to the result).
 *   json        -> no events (the contract is "exactly one object").
 *
 * **All three** formats must observe events. Even though json prints nothing, waiting still relies
 * on this observer's dwf trigger and turn-text recording. Therefore this function always returns
 * an observer, never undefined.
 */
export const createHeadlessSessionObserver = (
  input: HeadlessSessionObserverInput,
): HeadlessSessionObserver => {
  const { mapSessionEvent, options, stderr, stdout } = input;
  const writeStreamEvent = mapSessionEvent
    ? (event: SessionEvent) => {
        // One event per line, written as it happens. Deliberately not formatJson:
        // that pretty-prints with an indent, which would spread a single event
        // over several lines and break every line-oriented reader downstream.
        //
        // Emit dwf progress as a typed line: mapSessionEvent's default maps it to catch-all
        // `session.updated` (session-mapper.ts), which readers cannot distinguish or subscribe to separately.
        const line = isDynamicWorkflowRunProgressEvent(event)
          ? mapWorkflowRunProgressStreamLine(event)
          : mapSessionEvent(event);
        stdout.write(`${JSON.stringify(line)}\n`);
      }
    : undefined;
  const reportProgress =
    mapSessionEvent === undefined && wantsWorkflowProgress(options)
      ? createWorkflowProgressReporter({ write: (line) => void stderr.write(line) })
      : undefined;

  let workflowActivity = false;
  let waiting = false;
  let excludedTurnId: string | undefined;
  const turnResponses: string[] = [];

  return {
    hasWorkflowActivity: () => workflowActivity,
    beginWaitPhase: (excludeTurnId) => {
      waiting = true;
      excludedTurnId = excludeTurnId;
    },
    waitPhaseTurnResponses: () => turnResponses,
    observe: (event) => {
      writeStreamEvent?.(event);
      reportProgress?.(event);
      if (isWorkflowActivityEvent(event)) workflowActivity = true;
      if (!waiting || event.type !== SessionEventType.TurnComplete) return;
      // The first turn's text comes from submitPrompt's return value; a late turn_complete would otherwise double-count it.
      if (event.turnId !== undefined && String(event.turnId) === excludedTurnId) return;
      const response = (event.payload as { response?: unknown }).response;
      if (typeof response === "string" && response.trim().length > 0) turnResponses.push(response);
    },
  };
};

/**
 * Does this event prove that this process has dwf activity?
 *
 * Use two signals: a progress event is the most direct evidence, but its append is asynchronous and
 * could theoretically reach the sink after the turn ends. `BackgroundTaskStarted` is emitted
 * synchronously when the tool executor registers a background task and **must** occur within the
 * turn that started it, making it earlier and stronger evidence. Record both; either one triggers the wait.
 */
const isWorkflowActivityEvent = (event: SessionEvent): boolean => {
  if (isDynamicWorkflowRunProgressEvent(event)) return true;
  return (
    event.type === SessionEventType.BackgroundTaskStarted &&
    (event.payload as { taskKind?: unknown }).taskKind === "workflow"
  );
};

/** The runtime's two authoritative busy facts. Keep this narrower than AgentRuntime; waiting reads only these booleans. */
interface HeadlessWorkflowRuntimeFacts {
  hasActiveOrQueuedTurnWork: () => boolean;
  hasRunningBackgroundTasks: () => boolean;
}

/** Poll interval. Waits last minutes, so this granularity has negligible overhead and determines exit responsiveness. */
const HEADLESS_WORKFLOW_POLL_INTERVAL_MS = 100;

/**
 * Wait for in-flight workflow runs to settle **and for notification-driven turns to finish**.
 *
 * Why polling these two booleans is sufficient (there is no race window, the key argument for this
 * mechanism): there is **no await** between a background task becoming terminal
 * (`updateRuntimeBackgroundTask` in `background-tasks.ts`) and enqueuing its notification command
 * (`runtime-command-queue.ts`, through `maybeEnqueueBackgroundTaskNotification` ->
 * `enqueueBackgroundTaskNotification` -> `enqueueRuntimeCommand`). `drainRuntimeCommandQueue` also
 * sets `runtimeCommandDrainActive` before its first await. Thus "task is no longer running" and
 * "turn work is pending" change in one synchronous block, with no intermediate state for polling to observe.
 *
 * The predicate is deliberately **broader than dwf**: it also waits for concurrent background
 * Bash/subagent tasks. Their notification turns share a queue with workflow turns, so waiting for
 * them separately would not make sense. The **trigger** remains narrow (`hasWorkflowActivity`), so
 * runs with no dwf activity are unaffected.
 *
 * No timeout or environment-variable escape hatch: use Cancel or Ctrl-C. The latter uses existing
 * orphan cleanup to record the run as `stopped(interrupted)` (failure code `Interrupted`, resumable).
 * Once a signal aborts the wait, return immediately and never swallow it.
 */
export const waitForHeadlessWorkflowSettle = async (input: {
  intervalMs?: number;
  runtime: HeadlessWorkflowRuntimeFacts;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const intervalMs = input.intervalMs ?? HEADLESS_WORKFLOW_POLL_INTERVAL_MS;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!input.signal.aborted) {
    if (!input.runtime.hasRunningBackgroundTasks() && !input.runtime.hasActiveOrQueuedTurnWork()) {
      return;
    }
    await sleep(intervalMs);
  }
};

/**
 * Can this app's runtime provide busy facts?
 *
 * See `readRuntimeFunction` in `runtime-event-subscriber.ts` for why this is read dynamically (the
 * same `RunDependencies.createZCodeApp` injection boundary).
 *
 * **Do not silently degrade**: without busy facts, do not wait. This honestly reports that the host
 * lacks the capability instead of pretending the wait completed.
 */
export const readHeadlessRuntimeFacts = (
  runtime: unknown,
): HeadlessWorkflowRuntimeFacts | undefined => {
  const turnWork = readRuntimeFunction(runtime, "hasActiveOrQueuedTurnWork");
  const backgroundTasks = readRuntimeFunction(runtime, "hasRunningBackgroundTasks");
  if (!turnWork || !backgroundTasks) return undefined;
  return {
    hasActiveOrQueuedTurnWork: () => turnWork.call(runtime) === true,
    hasRunningBackgroundTasks: () => backgroundTasks.call(runtime) === true,
  };
};

/**
 * Should this run print workflow progress to stderr?
 *
 * Only `text` has this output surface: `json` requires exactly one object, while `stream-json` has
 * already encoded each progress event as a stdout line. The default (no --output-format and no
 * --json) is text, so it prints progress too.
 */
const wantsWorkflowProgress = (options: Pick<GlobalOptions, "json" | "outputFormat">): boolean =>
  options.outputFormat === undefined ? !options.json : options.outputFormat === "text";
