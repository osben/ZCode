/**
 * Pure logic for the workflow-run details page: Cancel availability, result/failure-panel decisions, and event-log row summaries.
 *
 * These are the only rule-heavy parts of the details page and can all be covered by exhaustive unit tests
 * without rendering a React Flow canvas. The component only places these results in the DOM.
 */
import {
  readWorkflowRunStopReason,
  type WorkflowRunStopReason,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunActor, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunConcurrencyEventLine } from "@/app-shell/workflowRunThrottle.js";

/** Maximum raw text for unknown event types; never load the entire journal into the event-log DOM. */
const UNKNOWN_PAYLOAD_MAX_LENGTH = 200;

/**
 * Cancel is available only for `running`.
 *
 * Cancellation uses the existing v4 `cancelBackgroundWork {workId: runId}` (one implementation for all three entry points,
 * with no second cancel RPC). It is already a no-op for terminal tasks, so disable the button in terminal states to avoid presenting
 * a control that does nothing, not as a fallback. A missing run (evicted by the eight-run limit or not yet projected at cold start)
 * cannot be cancelled either because its in-flight state is unknown.
 */
export function isWorkflowRunCancellable(run: WorkflowRunState | undefined): boolean {
  return run?.status === "running";
}

/**
 * Resume availability. **Single source**: the projected run's `resumable` state bit, computed by the CLI in the `run-settled`
 * payload using the **same predicate** as the resume gate (live and cold replay use the same derivation path). The UI must not infer
 * it from status + failureCode because the predicates could drift, showing an enabled button for a command that is rejected.
 *
 * A missing projection (evicted by the eight-run limit) is never resumable; omit the button rather than show a control guaranteed to be rejected.
 */
export function isWorkflowRunResumable(run: WorkflowRunState | undefined): boolean {
  return run?.resumable === true;
}

type WorkflowRunResultView =
  /** Run is absent from the projection; no result can be shown. */
  | { kind: "absent" }
  /** pending/running: there is no result panel yet. */
  | { kind: "none" }
  /**
   * Completed. `preview` is **always absent** at this stage: script artifacts exist only in `RunSettlement.artifact`, not in
   * the `run-settled` event (which carries only status and error) or the journal. Therefore completion can point only to the background-result turn
   * in the conversation; do not fabricate a result view. The schema retains the field and will display it if populated in the future.
   */
  | { kind: "completed"; preview?: string }
  /**
   * errored/stopped. `message` is preformatted raw text from the projection (the schema defines it as a string);
   * `stopReason` is present only for stopped runs when the projection includes that key.
   */
  | {
      kind: "error";
      status: "errored" | "stopped";
      stopReason?: WorkflowRunStopReason;
      message?: string;
    };

export function workflowRunResultView(run: WorkflowRunState | undefined): WorkflowRunResultView {
  if (!run) return { kind: "absent" };
  if (run.status === "errored" || run.status === "stopped") {
    const stopReason = readWorkflowRunStopReason(run);
    return {
      kind: "error",
      status: run.status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(run.error ? { message: run.error } : {}),
    };
  }
  if (run.status === "completed") {
    return { kind: "completed", ...(run.resultPreview ? { preview: run.resultPreview } : {}) };
  }
  return { kind: "none" };
}

/** One event-log input (an item in a v4 query result). */
export interface WorkflowRunEventItem {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
}

export interface WorkflowRunEventLine {
  sequence: number;
  type: string;
  /** Localized primary label. */
  label: string;
  /** Identity and data (station instance, actor name, log body, raw error); not localized. */
  detail?: string;
  /** Failure/cancellation color; all others use default (do not add visual vocabulary beyond the overlay's four values). */
  tone: "default" | "failed";
  truncated?: boolean;
}

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{siteId, ordinal}` → `site@ordinal` (same format as the engine's refToString, for comparison with logs). */
function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Return a non-empty string or undefined (joinDetail drops the whole segment rather than leaving an empty separator). */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === "string" && value.message.length > 0 ? value.message : undefined;
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * **Short summary** of a report entry in the event log (not the full preview in the Results section).
 *
 * Deliberately compress it to one line here: the event log is monospaced, one line per event, and multi-line JSON would expand it into a second
 * artifact view. The CLI prepares the full form (raw string / pretty-printed object JSON) in `workflowRuns.reports[].preview`;
 * the Results section renders that version.
 */
function reportItemSummary(item: unknown): string | undefined {
  if (item === undefined) return undefined;
  if (typeof item === "string") {
    return item.length > 0 ? truncate(item, UNKNOWN_PAYLOAD_MAX_LENGTH) : undefined;
  }
  try {
    const serialized = JSON.stringify(item);
    return serialized === undefined ? undefined : truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
  } catch {
    // The CLI already normalizes the payload into a JSON-serializable form; even if that guarantee fails, do not crash the entire log page.
    return undefined;
  }
}

/** Fallback for an unknown kind: type + truncated JSON. Do not crash or pretend to recognize it. */
function unknownDetail(payload: Record<string, unknown>): string | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    // The CLI already normalizes the payload into a JSON-serializable form; even if that guarantee fails, do not let one log row crash the panel.
    return undefined;
  }
  if (serialized === undefined || serialized === "{}") return undefined;
  return truncate(serialized, UNKNOWN_PAYLOAD_MAX_LENGTH);
}

const EVENT_KEY_PREFIX = "chat.toolCall.workflow.run.event.";

/**
 * Engine event → readable row.
 *
 * The vocabulary follows the kinds the **engine actually emits**: run-started / actor-created / node-queued /
 * node-dispatched / node-repairing / node-nudged / node-settled / usage-updated / log /
 * import-cache-closed / report / escalation-raised / escalation-resolved / run-settled, plus adaptive-concurrency
 * node-waiting / node-executing / concurrency-changed (the default branch is delegated to a related module first).
 * The driver emits the latter two inside the ask execution boundary (the engine core does not know about escalation), but they use the same two rails,
 * so they are grouped here with the related events. `payload` contains the event's fields other than `type` (the run service mapping contract),
 * so read engine field names directly without reshaping them.
 *
 * Each branch reads defensively by shape: payloads are bounded, so deep fields may have been truncated,
 * and an unreadable event must never crash the entire event log.
 */
export function workflowRunEventLines(
  events: readonly WorkflowRunEventItem[],
  formatMessage: FormatMessage,
): WorkflowRunEventLine[] {
  return events.map((event) => {
    const { payload } = event;
    const base = {
      sequence: event.sequence,
      type: event.type,
      ...(event.truncated ? { truncated: event.truncated as true } : {}),
    };
    const key = (suffix: string) => ({ id: `${EVENT_KEY_PREFIX}${suffix}` });

    switch (event.type) {
      case "run-started":
        // Do not show caps in this row; concurrency is not actionable information.
        return { ...base, label: formatMessage(key("runStarted")), tone: "default" };

      case "actor-created": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        return {
          ...base,
          label: formatMessage(key("actorCreated")),
          ...(joinDetail(name, refText(payload.actor)) === undefined
            ? {}
            : { detail: joinDetail(name, refText(payload.actor))! }),
          tone: "default",
        };
      }

      case "node-queued": {
        const kind = typeof payload.kind === "string" ? payload.kind : undefined;
        const detail = joinDetail(refText(payload.instance), kind);
        return {
          ...base,
          label: formatMessage(key("nodeQueued")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-dispatched":
      case "node-nudged": {
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key(event.type === "node-nudged" ? "nodeNudged" : "nodeDispatched")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-repairing": {
        const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "?";
        const detail = refText(payload.instance);
        return {
          ...base,
          label: formatMessage(key("nodeRepairing"), { attempt }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "node-settled": {
        const outcome =
          payload.outcome === "ok" ||
          payload.outcome === "failed" ||
          payload.outcome === "cancelled"
            ? payload.outcome
            : undefined;
        const outcomeLabel = outcome
          ? formatMessage({ id: `chat.toolCall.workflow.run.outcome.${outcome}` })
          : "";
        const detail = joinDetail(refText(payload.instance), errorMessage(payload.error));
        return {
          ...base,
          label: formatMessage(key(payload.cached === true ? "nodeSettledCached" : "nodeSettled"), {
            outcome: outcomeLabel,
          }),
          ...(detail === undefined ? {} : { detail }),
          // failed and cancelled differ in the journal, but this row only needs to say the step did not succeed.
          tone: outcome === "failed" || outcome === "cancelled" ? "failed" : "default",
        };
      }

      case "usage-updated": {
        // The event carries the cumulative amount spent; the authoritative value is in the usage row of the status header.
        const spentTokens =
          typeof payload.spentTokens === "number" ? payload.spentTokens : undefined;
        return {
          ...base,
          label: formatMessage(key("usageUpdated")),
          ...(spentTokens === undefined
            ? {}
            : { detail: `${spentTokens.toLocaleString()} tokens` }),
          tone: "default",
        };
      }

      case "log": {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        return {
          ...base,
          label: formatMessage(key("log")),
          ...(message === undefined ? {} : { detail: message }),
          tone: "default",
        };
      }

      /** Control flow passed a `phase("…")` marker: include its name and entry number (replay exports still use this formatter). */
      case "import-cache-closed": {
        // Imported-cache closure during amend-resume: identify whose first write closed the gate.
        // detail = subagent name when available + instance; world.run has no name, only an instance.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(actorName, refText(payload.instance));
        return {
          ...base,
          label: formatMessage(key("importCacheClosed")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "phase-entered": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const ordinal = typeof payload.ordinal === "number" ? payload.ordinal : 1;
        return {
          ...base,
          label: formatMessage(key("phaseEntered")),
          ...(name === undefined ? {} : { detail: ordinal >= 2 ? `${name} · ${ordinal}` : name }),
          tone: "default",
        };
      }

      /**
       * Both report and log are fire-and-forget, but report **has a site identity** (`report#N@k` in the journal),
       * so this row includes the instance. The entry body belongs elsewhere (the full preview in Results); provide only a short summary here.
       * The event log's role is "what the engine emitted and when", not a second artifact view.
       */
      case "report": {
        const detail = joinDetail(refText(payload.instance), reportItemSummary(payload.item));
        return {
          ...base,
          label: formatMessage(key("report")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      /**
       * Escalated question: an actor hits a real blocker and escalates it to the main agent,
       * then waits in its ask until answered. The actor resumes in place after the main agent responds by qid.
       *
       * Both rows start with **qid**, even though the raised row is about "who asked what": qid is the only join key between these events,
       * which are often dozens of rows apart in the log (the wait is the whole point of the feature). Without it,
       * "Answered" cannot be connected to its question.
       *
       * Truncate the body using the existing detail-column convention (same limit as report summaries): the event log is one line per event,
       * and the full question belongs in the "Pending questions" section above.
       */
      case "escalation-raised": {
        const question = typeof payload.question === "string" ? payload.question : undefined;
        // If the actor name is absent (anonymous actor), fall back to station instance; show `actor#1@1` rather than omitting who it was.
        const actorName = typeof payload.actorName === "string" ? payload.actorName : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          actorName ?? refText(payload.actor),
          question === undefined ? undefined : truncate(question, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationRaised")),
          ...(detail === undefined ? {} : { detail }),
          // Escalation is not failure: the actor did nothing wrong and is waiting for an answer. Reserve failure coloring for rows that actually failed.
          tone: "default",
        };
      }

      case "escalation-resolved": {
        const answer = typeof payload.answer === "string" ? payload.answer : undefined;
        const detail = joinDetail(
          nonEmptyText(payload.qid),
          answer === undefined ? undefined : truncate(answer, UNKNOWN_PAYLOAD_MAX_LENGTH),
        );
        return {
          ...base,
          label: formatMessage(key("escalationResolved")),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }

      case "run-settled": {
        const status =
          typeof payload.status === "string" && payload.status.length > 0
            ? payload.status
            : undefined;
        const statusLabel = status
          ? formatMessage({ id: `chat.toolCall.workflow.run.status.${status}` })
          : "";
        const detail = errorMessage(payload.error);
        return {
          ...base,
          label: formatMessage(key("runSettled"), { status: statusLabel }),
          ...(detail === undefined ? {} : { detail }),
          tone: status === "errored" || status === "stopped" ? "failed" : "default",
        };
      }

      default: {
        // The four concurrency events (node-waiting / node-executing / concurrency-changed / run-caps-changed)
        // live in the related workflowRunThrottle.ts module (max-lines limit).
        const concurrencyLine = workflowRunConcurrencyEventLine(event, formatMessage);
        if (concurrencyLine !== undefined) return concurrencyLine;
        // For example, `compaction`, reserved by the engine for long-context compaction (never emitted in v1).
        // If it appears later, this must still produce an informative row rather than a blank.
        const detail = unknownDetail(payload);
        return {
          ...base,
          label: formatMessage(key("unknown"), { type: event.type }),
          ...(detail === undefined ? {} : { detail }),
          tone: "default",
        };
      }
    }
  });
}

// ── Transcript entry point: step card → actor instance ──

/**
 * An actor instance that can be opened.
 *
 * `siteId` + `ordinal` identify it (journal key); `name` is display-only. `sessionId` is the ID of the real persisted
 * session and the only value required by a nested read-only SessionPane.
 *
 * `sessionId` **may be absent** (schema-optional): progress events can arrive before the actor session is persisted, older runs may not have one,
 * and slots that have not started never have one. An instance without it can still open a tab—the tab identity is (runId, siteId, ordinal),
 * while session ID is only the accompanying subscription target. Without it, the tab shows a "Not started" placeholder.
 */
export interface WorkflowActorInstance {
  siteId: string;
  ordinal: number;
  name?: string;
  sessionId?: string;
  status: WorkflowRunActor["status"];
}

// ── Gate for actors that have not started ──

/**
 * Three possible states for an actor transcript tab with respect to whether its session exists.
 *
 * `unknown` is not an error; it is the **most common long-lived state**. Tabs are intentionally not garbage-collected and can outlive eviction from the eight-run projection.
 */
type WorkflowActorStartState = "notStarted" | "started" | "unknown";

/** Identity passed from an actor transcript tab to the gate: slot + session ID known at open time (optional). */
export interface WorkflowActorSlotRef {
  runId: string;
  siteId: string;
  ordinal: number;
  actorSessionId?: string;
}

/** Gate decision: state + session ID to subscribe to (absent means nothing can be subscribed to and the panel shows a placeholder). */
interface WorkflowActorGate {
  state: WorkflowActorStartState;
  sessionId?: string;
}

/**
 * Slot → whether the actor has started and which session to subscribe to.
 *
 * Actor sessions are **lazy-created**: the engine calls `createActorSession` only when the first ask is dispatched. Subscribing before then
 * always produces `fault.subscribe.sessionNotFound`, and the projection store remains in `error` waiting for manual retry—a dead panel.
 * This selector is the gate that prevents it.
 *
 * Race-free decision: `createActorSession` is awaited until the session is persisted before the first dispatch (`workflow-driver.ts`
 * ordering is covered by tests), so **seeing dispatched in the projection ⇒ session row exists ⇒ subscription will succeed**.
 * Conversely, `queued` does not mean started: persistence is guaranteed before dispatch, so a queued node is not evidence that a session exists.
 *
 * Look up by **(runId, siteId, ordinal)**: a tab can be opened before the actor appears
 * (an unstarted pill), when there is no session ID to look up. The distinction between `unknown` and `notStarted` remains important:
 *
 * - Actor absent from projection, tab **has** a session ID → `unknown`, **never block**. After a run is evicted by the eight-run limit or
 *   cold recovery leaves the projection empty, direct subscription is the only path to the transcript; blocking it would close the only persisted view of a completed run.
 * - Actor absent from projection, tab has **no** session ID → `notStarted`: nothing can be subscribed to, so a placeholder is accurate
 *   (the script has not reached `agent()`, or the slot truly never started before the run was evicted).
 * - Actor is present, but has no non-`queued` nodes → `notStarted`; otherwise `started`. Use the projected session ID as the subscription target,
 *   falling back to the ID carried when the tab opened. This gate reads the live projection and heals as soon as the first node is dispatched.
 *
 * Documented exception: a completed cache hit during resume emits `node-settled` directly without `ensureSession`, so the actor session may truly be absent.
 * settled opens the gate, subscription fails, and the existing error+retry panel appears; that really is "session not found", so the existing fallback is correct.
 */
export function workflowActorStartState(
  runs: readonly WorkflowRunState[] | undefined,
  slot: WorkflowActorSlotRef,
): WorkflowActorGate {
  const run = runs?.find((candidate) => candidate.runId === slot.runId);
  const actor = run?.actors.find(
    (candidate) => candidate.siteId === slot.siteId && candidate.ordinal === slot.ordinal,
  );
  const sessionId = actor?.sessionId ?? slot.actorSessionId;
  const withSession = sessionId === undefined ? {} : { sessionId };
  if (run === undefined || actor === undefined) {
    return { state: sessionId === undefined ? "notStarted" : "unknown", ...withSession };
  }
  // Match ownership by `siteId` + `ordinal` (journal key): a different ordinal means a different instance.
  // world-read nodes omit both fields, so they never open the gate for anyone.
  const started = run.nodes.some(
    (node) =>
      node.actorSiteId === actor.siteId &&
      node.actorOrdinal === actor.ordinal &&
      // `queued` is the only phase that does **not** prove the session exists. Use the complement instead of listing dispatched/repairing/
      // nudged/settled so future phases open the gate by default, consistent with `unknown` never blocking.
      node.phase !== "queued",
  );
  return { state: started ? "started" : "notStarted", ...withSession };
}
