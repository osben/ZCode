// ============================================================
// Shared surface for workflow-run introspection tools (ListWorkflowRuns / GetWorkflowRun).
// ============================================================
//
// These three things must be shared verbatim, so they live here instead of being duplicated in both handlers:
//
//   1. **Business failure for missing capability**. A missing port (journal unavailable → the run service is not constructed) and
//      a present port with a missing method (journal has no introspection query) mean the same thing to the model: this session lacks the capability.
//      Two tools, two checks, one message.
//   2. **Failure codes**. `ToolHandlerFailure.errorCode` is a number (`isToolHandlerFailure` in the executor checks for a number),
//      so the two stable discriminator keys (`workflow_introspection_unavailable` / `run_not_found`) go in the message prefix—
//      the only discriminator visible to the model and logs.
//   3. **Async guidance text**. Both tool descriptions must explain that runs started in this session deliver a completion notification with artifacts;
//      divergent copy would give the model two different defaults.

import { escapeXml } from "../../runtime-task/notification.js";
import type { ToolHandlerFailure } from "../types.js";

/**
 * Business failure codes. The number itself is not sent to the model (the executor projects it as `code: "1"`); the discriminator is in the message prefix.
 * The codes must differ because the model must handle missing capability and an unknown run separately.
 */
const WORKFLOW_RUN_INTROSPECTION_ERROR_CODE = {
  INTROSPECTION_UNAVAILABLE: 1,
  RUN_NOT_FOUND: 2,
} as const;

/**
 * "This session has no workflow introspection capability." **Never** silently return an empty list; that would make the model conflate
 * "this project has not run a workflow" with "this session cannot read workflows" (the same reason CreateWorkflow uses a visible fallback).
 */
export function workflowIntrospectionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.INTROSPECTION_UNAVAILABLE,
    message:
      "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.",
  };
}

export function workflowRunNotFoundFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.RUN_NOT_FOUND,
    message: `run_not_found: no workflow run with ID ${runId} exists for this project. Use ListWorkflowRuns to see the runs that do.`,
  };
}

/**
 * Async guidance shared by both tool descriptions.
 *
 * Do not disable polling; it remains appropriate when the user explicitly asks to watch an in-flight run. This sets only the default behavior.
 */
export const WORKFLOW_RUN_INTROSPECTION_STEERING = [
  "Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.",
  "Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project's earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run's full record by ID.",
].join("\n");

/**
 * Convert epoch milliseconds to ISO 8601 (UTC). Structured output keeps timestamps as epoch milliseconds (the journal's raw fact), while the model-facing output uses
 * ISO, which makes it easy to tell how long ago something happened without doing mental arithmetic on a 13-digit number.
 *
 * Invalid values (NaN / out of range) fall back to the original number instead of throwing; one timestamp should not fail the entire tool result.
 */
export function formatWorkflowRunTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return String(epochMs);
  }
}

/** Duration thresholds, defined once for summaries and formatters so separate copies cannot drift after tuning. */
const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Convert milliseconds to a human-readable duration (`40s` / `5m 10s` / `2h 15m` / `3d 2h`).
 *
 * Keep only two units: readers need the order of magnitude, not precision, and `1h 02m 03s` makes them count digits. Zero-pad minutes and seconds
 * (both are base-60 subunits; without padding, `1m 5s` and `1m 50s` are easy to confuse), but do not pad hours under days.
 * Convert non-finite and negative values (clock rollback) to 0 so one timestamp cannot turn the whole tool result into NaN.
 */
export function formatWorkflowRunDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    const seconds = Math.floor((total % DURATION_MS.minute) / DURATION_MS.second);
    return `${minutes}m ${padTwo(seconds)}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    const minutes = Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute);
    return `${hours}h ${padTwo(minutes)}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  const hours = Math.floor((total % DURATION_MS.day) / DURATION_MS.hour);
  return `${days}d ${hours}h`;
}

/**
 * Return "how long ago." If `at` is missing or not finite, return `undefined`; the read side then **omits the entire age**,
 * rather than rendering 0 or "unknown." An old journal without a timestamp cannot provide an age; that is a fact.
 */
export function formatRelativeAge(now: number, at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at) || !Number.isFinite(now)) return undefined;
  return `${formatWorkflowRunDuration(now - at)} ago`;
}

/** Format an ISO timestamp and relative age; show only the ISO timestamp when age is unknown. */
export function formatWorkflowRunInstant(now: number, at: number): string {
  const age = formatRelativeAge(now, at);
  const iso = formatWorkflowRunTimestamp(at);
  return age === undefined ? iso : `${iso} (${age})`;
}

/**
 * Add thousands separators. `toLocaleString` depends on the host's ICU data, but every character shown to the model must be testable
 * exactly, so insert commas here.
 */
export function formatWorkflowRunCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * XML-like attribute. Collapse whitespace to single spaces before escaping: newlines in an attribute break the "one run per line" layout,
 * and label is free text (a user-provided name or the first script line).
 */
export function workflowRunAttribute(name: string, value: string | number | boolean): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : String(value);
  return `${name}="${escapeXml(text)}"`;
}

/**
 * **Reuse** the escaping function from the runtime-task notification projection (notification.ts): both are the same kind of
 * XML-like model-facing projection, and a second copied escaping table would drift during a future change.
 */
export { escapeXml as escapeWorkflowRunText };
