/**
 * Adaptive concurrency view for the dwf run details page:
 * concurrency/cooldown readings in the run header and rows for the four events in the log: `node-waiting` / `node-executing` / `concurrency-changed` /
 * `run-caps-changed`. The subagent badge is **not** here: it has only three one-word states and is rendered directly from protocol
 * actor state.
 *
 * Display rules share event types with workflowRunPanel.ts and also record the **first-seen time** of each state locally.
 * The protocol carries only relative values (`cooldownMs`—the engine has no clock), so the UI can derive the deadline only from
 * “when this state was first observed.” Registration is keyed by object identity (WeakMap): reduction preserves the same `concurrency` object
 * while unchanged; replacement by a new event creates a new object and registers it again. This stays out of the protocol because it is a local observation, not an engine fact.
 */
import type { WorkflowRunConcurrency } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunEventItem, WorkflowRunEventLine } from "./workflowRunPanel.js";

const MS_PER_SECOND = 1_000;
const I18N_PREFIX = "chat.toolCall.workflow.run.";
const EVENT_KEY_PREFIX = `${I18N_PREFIX}event.`;

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * Throttle reason → short-label i18n key (reason is an open string; map only known categories and put the rest
 * under “Transient error.” Completely unknown values are displayed as-is—unrecognized does not mean hidden).
 */
const REASON_LABEL_KEY: Readonly<Record<string, string>> = {
  rate_limited: "throttle.reason.rateLimited",
  provider_overloaded: "throttle.reason.overloaded",
  offpeak_queued: "throttle.reason.offpeak",
  server_error: "throttle.reason.transient",
  network_error: "throttle.reason.transient",
  timeout: "throttle.reason.transient",
  stream_idle_timeout: "throttle.reason.transient",
  stale_connection: "throttle.reason.transient",
  proxy_error: "throttle.reason.transient",
};

export function throttleReasonLabel(reason: string, formatMessage: FormatMessage): string {
  const key = REASON_LABEL_KEY[reason];
  return key === undefined ? reason : formatMessage({ id: `${I18N_PREFIX}${key}` });
}

// ── Record receive time ──

const concurrencyReceivedAt = new WeakMap<WorkflowRunConcurrency, number>();

function stamp<T extends object>(registry: WeakMap<T, number>, subject: T, now: number): number {
  const seen = registry.get(subject);
  if (seen !== undefined) return seen;
  registry.set(subject, now);
  return now;
}

// ── Run header ──

interface WorkflowRunConcurrencyView {
  /**
   * Number on the chip: **actual** concurrency, `min(cap, limit)`—the smaller of the shared bucket cap and this run's own limit. Users see how many subagents
   * can actually run for this run right now; the number does not need to say which limit is active.
   */
  cap: number;
  ceiling: number;
  /** Cooldown deadline (epoch ms); absent when there is no cooldown or it has expired. */
  cooldownUntil?: number;
}

/**
 * Concurrency reading for the run header. Present only when **actual concurrency < ceiling**; there is nothing to report for a run already at its limit.
 * Compute cooldown deadline from receive time + `cooldownMs`; omit it once expired so the UI does not show a time in the past.
 */
export function workflowRunConcurrencyView(
  concurrency: WorkflowRunConcurrency | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (concurrency === undefined) return undefined;
  const effective = Math.min(concurrency.cap, concurrency.limit ?? concurrency.cap);
  if (effective >= concurrency.ceiling) return undefined;
  const view: WorkflowRunConcurrencyView = { cap: effective, ceiling: concurrency.ceiling };
  if (concurrency.cooldownMs !== undefined) {
    const until = stamp(concurrencyReceivedAt, concurrency, now) + concurrency.cooldownMs;
    if (until > now) view.cooldownUntil = until;
  }
  return view;
}

// ── Event log ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/** Read engine caps (`{ maxConcurrency }`); show “?” if unreadable, using the same fallback as previous/next. */
function capsMaxConcurrency(value: unknown): string {
  if (!isRecord(value)) return "?";
  return typeof value.maxConcurrency === "number" ? String(value.maxConcurrency) : "?";
}

/**
 * Four concurrency events (node-waiting / node-executing / concurrency-changed / run-caps-changed) map to event-log rows;
 * return undefined for other kinds (the main table handles them with its default fallback). Follow the other branches in workflowRunEventLines:
 * read payloads defensively so one unreadable event never breaks the page. All tones are default: waiting is not failure, nor is a cap change—
 * the first three are runtime adjustments and the last is a user adjustment.
 */
export function workflowRunConcurrencyEventLine(
  event: WorkflowRunEventItem,
  formatMessage: FormatMessage,
): WorkflowRunEventLine | undefined {
  const { payload } = event;
  const base = {
    sequence: event.sequence,
    type: event.type,
    ...(event.truncated ? { truncated: event.truncated as true } : {}),
    tone: "default" as const,
  };
  const withDetail = (label: string, detail: string | undefined): WorkflowRunEventLine => ({
    ...base,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (event.type) {
    // node-waiting: cause=slot means queued before the gate and needs no extra detail; cause=backoff includes the runner's
    // backoff reason and duration. The badge does not show these details, so the event log is their only display location.
    case "node-waiting": {
      if (payload.cause !== "backoff") {
        return withDetail(
          formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingSlot` }),
          refText(payload.instance),
        );
      }
      const reason =
        typeof payload.reason === "string"
          ? throttleReasonLabel(payload.reason, formatMessage)
          : "?";
      const seconds =
        typeof payload.delayMs === "number"
          ? String(Math.ceil(payload.delayMs / MS_PER_SECOND))
          : "?";
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingBackoff` }, { reason, seconds }),
        refText(payload.instance),
      );
    }
    case "node-executing":
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeExecuting` }),
        refText(payload.instance),
      );
    case "concurrency-changed": {
      const previous = typeof payload.previous === "number" ? String(payload.previous) : "?";
      const next = typeof payload.next === "number" ? String(payload.next) : "?";
      const key =
        typeof payload.key === "string" && payload.key.length > 0 ? payload.key : undefined;
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}concurrencyChanged` }, { previous, next }),
        key,
      );
    }
    // run-caps-changed: the user changed this run's **own** limit while it was running (effective immediately, without starting another run).
    // Keep it distinct from the event above: `concurrency-changed` means the governor throttled the shared bucket (a provider-key concern); this event is
    // the user's choice. It has no detail because it belongs to no provider key or individual instance.
    case "run-caps-changed":
      return withDetail(
        formatMessage(
          { id: `${EVENT_KEY_PREFIX}runCapsChanged` },
          {
            previous: capsMaxConcurrency(payload.previous),
            next: capsMaxConcurrency(payload.caps),
          },
        ),
        undefined,
      );
    default:
      return undefined;
  }
}
