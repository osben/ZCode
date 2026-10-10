// ============================================================
// Cold replay for Dynamic Workflow Run: journal → the same progress payloads as live execution.
// ============================================================
// The `workflowRuns` projection has only an in-memory source and is empty after restart. dwf_event contains every event emitted by the engine,
// in the same bounded serialization used to feed the live projection. This module remints them in journal order as DynamicWorkflowRunProgressPayload values;
// cold materialization feeds these payloads as in-memory events to the same reducer, making the projection byte-for-byte identical before and after restart.
//
// Kept separate instead of placing it in observation.ts: the payload-minting chain (toProgressPayload) lives in launch.ts, which already imports
// observation.ts for predicates. Importing in the reverse direction would create a cycle.

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";

/**
 * All progress payloads for one run, in ascending journal sequence.
 *
 * **The row is authoritative for settlement:** when the row is terminal (completed / errored / stopped), always mint the final `run-settled`
 * from the row. Replace a trailing stored `run-settled` if present; otherwise append it (process death and orphan reconciliation update only
 * the row and deliberately do not synthesize events—the journal contract is "what the engine emitted"). Use the same payload-minting chain and resumable
 * predicate (inside toProgressPayload); the reducer's `run-settled` branch already performs normalization, so no second normalizer is needed.
 * The minted payload **exists only in this replay's return value** and is never written to dwf_event.
 *
 * The terminal-state rename (completed / errored / stopped) was applied only in the row codec; dwf_event payloads remain raw JSON, so older
 * `run-settled` events contain the old terms `cancelled` / `failed`. The old implementation skipped minting when it saw a trailing `run-settled`,
 * passing those old terms to the reducer. The reducer did not recognize them and left the run as running: the card stayed active and Cancel remained enabled even though the backend had nothing to cancel.
 * The row is the sole authority for state (the codec already translates old rows), so always derive settlement from the row. Cold replay can no longer lie based on old event wording,
 * and both paths produce byte-for-byte identical payloads for the new state vocabulary (the engine's `run-settled` contains exactly the four row fields); the live/cold consistency contract is unchanged.
 *
 * `concurrencyCeiling` is **required**, not optional: it is a host-derived field on the `run-started` payload and is always present in live execution
 * (computed at launch). Omitting it here would make the first cold-replay payload differ by one key, violating this module's only contract: byte-for-byte equality.
 * The caller provides the same `resolveWorkflowConcurrencyCeiling`.
 */
export function replayRunProgress(
  row: DwfRunSessionListItem,
  journal: Pick<JournalStorePort, "listEvents">,
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  return replayRunProgressFromEvents(row, journal.listEvents(row.runId, {}), concurrencyCeiling);
}

/**
 * Use the same payload-minting chain, with events **already read by the caller**.
 *
 * There is one reason for this helper: `getRunDetail` must derive both run state and a situation snapshot based on event times in one call.
 * Having both sides call `listEvents` would pay twice for the same data, and this is the most expensive read path for long runs.
 *
 * The caller must provide **all events for the run, sorted by ascending sequence** (the result of `listEvents(runId, {})`);
 * trailing settlement replacement relies on the final row actually being last.
 */
export function replayRunProgressFromEvents(
  row: DwfRunSessionListItem,
  stored: readonly StoredEvent[],
  concurrencyCeiling: number,
): DynamicWorkflowRunProgressPayload[] {
  const toolCallId = row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId };
  // Launch anchor: use the same minting chain as live so derived fields match.
  // Byte-for-byte equality between cold and live payloads is this module's contract (locked by tests). The anchor is in this event batch (the first
  // run-launched event), so no extra journal query is needed; runs launched before the upgrade lack it, so the field is omitted.
  const launched = stored.find((entry) => entry.event.type === "run-launched")?.event;
  const launchInputId =
    launched?.type === "run-launched" ? { launchInputId: launched.inputId } : {};
  // Lineage pointer uses the same source as live (launch reads input or the journal row; here it is read directly from the row).
  const resumedFrom = row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom };
  // Subagent model uses the **same source** as the anchor: the same `run-launched` event (zero SQL; dwf_run has no such column).
  // Live execution reads the same canonical string from launch input or that event, so the payloads remain byte-for-byte equal. Present only if set.
  const subagentModel =
    launched?.type === "run-launched" && launched.subagentModel !== undefined
      ? { subagentModel: launched.subagentModel }
      : {};
  const terminal = TERMINAL_RUN_STATUSES.has(row.status);
  const last = stored.at(-1);
  // Replace settlement only at the **tail**: a resumed run may contain a prior lifecycle's `run-settled` in its history; that is real history,
  // and the following `run-started` returns it to running (existing reducer semantics), so leave it untouched.
  const trailingSettle = terminal && last?.event.type === "run-settled" ? last : undefined;
  const replayable = trailingSettle === undefined ? stored : stored.slice(0, -1);
  const payloads = replayable.map((entry) =>
    toProgressPayload({
      event: entry.event,
      runId: row.runId,
      sequence: entry.sequence,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  if (!terminal) return payloads;
  const settled: RunEvent = {
    type: "run-settled",
    status: row.status,
    // A stopped row always has a reason (the repository defaults missing values in legacy rows to user); other states omit it.
    ...(row.status === "stopped" ? { stopReason: row.stopReason ?? "user" } : {}),
    ...(row.status === "stopped" && row.supersededBy !== undefined
      ? { supersededBy: row.supersededBy }
      : {}),
    ...(row.failure === undefined ? {} : { error: row.failure }),
  };
  payloads.push(
    toProgressPayload({
      event: settled,
      runId: row.runId,
      // When replacing, keep the replaced event's sequence (matching the live watermark); when appending, use the next sequence after the last event.
      sequence: trailingSettle?.sequence ?? (last?.sequence ?? 0) + 1,
      ...toolCallId,
      ...launchInputId,
      ...resumedFrom,
      ...subagentModel,
      concurrencyCeiling,
    }),
  );
  return payloads;
}
