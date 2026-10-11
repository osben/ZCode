// ============================================================
// Dynamic Workflow Run Service: change the concurrency limit of an active run in place.
// ============================================================
// docs/dynamic-workflow/concurrency.md "Retuning a live run". This implements
// `DynamicWorkflowRunPort.retuneConcurrency` and deliberately lives apart from the three launch
// entry points (dynamic-workflow-run-submit.ts): those all **mint a run**; this mints none and
// only sends a command to a run that is already active.
//
// The two rejection types are checked in **different places**, which is why they remain distinct:
//   - `unchanged` is decided here from the limit currently held by the service, before calling the handle.
//   - The engine setter then has only one reason to return false: the run settled between those steps. The port reports that as `not_live`.
//
// Ordering affects correctness: call the handle first (the engine updates caps, writes the row, records an event, and changes the gate limit in one synchronous turn), then update
// the service's in-memory copy only if it succeeds. Reversing this order could leave an in-memory limit that disagrees with the `dwf_run` row if the run settles at that moment;
// snapshots and detail views read this copy.

import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import { normalizeRunConcurrency } from "./workflow-default-concurrency.js";

/** Internal service state borrowed by this module; these are references, and this file owns no state. */
export interface DynamicWorkflowRunRetuneContext {
  runs: Map<string, RunRegistryEntry>;
  journal: JournalStorePort;
  /** Same function used for the caps default and both read surfaces (see run service's `defaultConcurrency`). */
  defaultConcurrency: () => number;
}

export function retuneRunConcurrency(
  ctx: DynamicWorkflowRunRetuneContext,
  request: DynamicWorkflowRunRetuneRequest,
): DynamicWorkflowRunRetuneResult {
  const defaultConcurrency = ctx.defaultConcurrency();
  // `null` = default concurrency = remove this run's own limit. Use the **same** rule as
  // submission (floor, at least 1, no upper bound; the tool layer already normalized once so the
  // reply states the value that will take effect; the port normalizes again as part of its own
  // contract, and both results must match).
  const next = normalizeRunConcurrency(request.maxConcurrency ?? undefined, defaultConcurrency);

  const entry = ctx.runs.get(request.runId);
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    // This service has no active entry: the run was never in this process, already settled, or was left by an older version without a control surface.
    // All three cases have the same next step for the caller: perform a real amendment.
    return { ok: false, reason: "not_live" };
  }

  // Effective limit right now: **read the entry when present** (all three entry-creation paths set
  // it); use the journal only for a cold row. If neither has a value, wiring failed in the
  // microtasks between submit → createRun; interpret it as running at the default concurrency.
  const current =
    entry.maxConcurrency ??
    ctx.journal.getRun(request.runId)?.caps.maxConcurrency ??
    defaultConcurrency;
  if (current === next) return { ok: false, reason: "unchanged", current };

  if (!entry.control.setMaxConcurrency(next)) {
    // The entry still exists but the engine says no change: the run settled between the liveness check and this call (a race), or the engine is not attached yet
    // (in the microtasks before launch). In either case it cannot be changed in place now.
    return { ok: false, reason: "not_live", current };
  }
  // Update the in-memory copy too: snapshots read `entry.maxConcurrency ?? row`, with the entry taking precedence. Without this, after retune they would keep reporting
  // the value from submission, and `AmendWorkflow`'s resolveInput reads this snapshot to decide what to preserve.
  entry.maxConcurrency = next;
  return { ok: true, maxConcurrency: next, previous: current, defaultConcurrency };
}
