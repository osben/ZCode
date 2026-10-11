/**
 * scheduler.ts reached oxlint's max-lines limit (400), so Boundary B's two upward reports
 * (submit_result arrival and turn end), their repair/nudge budgets, and submit normalization were
 * moved to this file; the public surface is still exported from scheduler.ts.
 *
 * Free functions use {@link SubmitSeam} to access the scheduler's live-node table and two
 * settlement entry points; submitAttempted / turnEnded on AskScheduler are thin delegates.
 */

import type { AskNode, SchedulerHost } from "./scheduler-types.js";
import type { InstanceRef, Violation } from "./types.js";
import { REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

/** Minimal seam exposed by the scheduler to report handling: find live nodes and settle by result. */
export interface SubmitSeam {
  readonly host: SchedulerHost;
  /** Find a live node by instance (returns undefined once it leaves liveNodes). */
  liveNode(instance: InstanceRef): AskNode | undefined;
  settleOk(node: AskNode, artifact: unknown): void;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export function handleSubmitAttempted(
  seam: SubmitSeam,
  instance: InstanceRef,
  payload: unknown,
): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  // Untyped asks do not provide submit_result; even if one arrives, do not settle from it.
  if (!node.spec.typed) return;

  const { value, violations } = normalizeSubmit(seam.host, node.spec.schema, payload);
  if (violations.length === 0) {
    seam.host.driver.respondToSubmit(instance, { kind: "accept" });
    seam.settleOk(node, value);
    return;
  }
  if (node.repairsRemaining > 0) {
    node.repairsRemaining--;
    const attempt = REPAIR_ATTEMPTS - node.repairsRemaining;
    seam.host.driver.respondToSubmit(instance, { kind: "reject", violations });
    seam.host.record({ type: "node-repairing", instance, attempt, violations });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ValidationFailed",
      "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
      { violations },
    ),
  );
}

/**
 * Loosely normalize a submit payload: validate the original value first. Only if it fails and is a
 * string, run JSON.parse once and validate again; on success, use the parsed value for both the
 * decision and journal entry.
 *
 * Production behavior observed (GLM-5.3 through an Anthropic-compatible endpoint): models often
 * serialize submit_result's `result` argument as a JSON string (for example,
 * `"{\"title\":...}"`) instead of a JSON object. The validator correctly reports “expected object,
 * got string,” and the run fails after three repair attempts. The legacy script-workflow's
 * parseStructuredResponse already tolerates this with loose JSON parsing; add equivalent,
 * schema-aware tolerance here:
 *   1. If the original value passes, use it without parsing (preserving valid string results, such
 *      as `"42"` for a `string | null` schema).
 *   2. If the original fails and is a string, run JSON.parse once (no recursion or double parsing,
 *      following the legacy single-extraction precedent), then validate and use the parsed value if
 *      it passes.
 *   3. Otherwise return the original value and violations for model repair.
 * The engine is a pure package, and JSON.parse is deterministic and performs no I/O, so it is safe here.
 */
function normalizeSubmit(
  host: SchedulerHost,
  schema: unknown,
  payload: unknown,
): { value: unknown; violations: Violation[] } {
  const direct = host.validate(schema, payload);
  if (direct.length === 0) return { value: payload, violations: [] };
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      const after = host.validate(schema, parsed);
      if (after.length === 0) return { value: parsed, violations: [] };
      // Bug: when parsing succeeded but the parsed value still failed validation, the pre-parse
      // `direct` violation ("$: expected object, got string") was reported. The model actually saw
      // a decoded object and could not fix that error, so it repeatedly added quotes, double-encoded,
      // or degraded to "{}" until the repair budget ran out. Repair violations must describe a value
      // the model can modify, so return `after` here (path-level violations on the parsed object)
      // without changing the single-parse contract.
      return { value: parsed, violations: after };
    } catch {
      // Non-JSON string: JSON.parse throws, so fall back to the original-value violations for model repair.
    }
  }
  return { value: payload, violations: direct };
}

export function handleTurnEnded(seam: SubmitSeam, instance: InstanceRef, finalText: string): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  if (!node.spec.typed) {
    seam.settleOk(node, finalText);
    return;
  }
  if (node.nudgesRemaining > 0) {
    node.nudgesRemaining--;
    seam.host.driver.respondToSubmit(instance, { kind: "nudge" });
    seam.host.record({ type: "node-nudged", instance });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ResultNotSubmitted",
      "The typed ask ended without a submit_result call, so there is no result.",
      { finalText },
    ),
  );
}
