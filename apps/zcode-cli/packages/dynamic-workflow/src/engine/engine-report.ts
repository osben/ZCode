/**
 * engine.ts reached oxlint's max-lines limit (400), so the `report()` publication path
 * (serialization probe, replay deduplication, label validation, two caps, one write) was moved to
 * this file; the public surface is still exported from engine.ts.
 *
 * The free function reads and writes engine state through the {@link EngineState} seam;
 * WorkflowEngine.report is only a thin delegate.
 */

import { inputHash } from "./hash.js";
import { REPORT_CAPS } from "../facade/report-caps.js";
import { declaredPresetIds, isDeclaredPreset } from "./engine-artifacts.js";
import { hashMismatch } from "./hash-mismatch.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish an intermediate result (`report` in Boundary A). Synchronous, no return value, and no
 * driver round trip: write one journal row and emit one event.
 *
 * The four steps below must stay in this order:
 *
 * 1. **Probe serialization first**. One `JSON.stringify` yields both whether the item is JSON-representable
 *    and its byte size (the limit metric). This must happen before canonicalJson: a cyclic item makes
 *    canonicalJson recurse until a stack overflow, a crash rather than a readable failure.
 * 2. **Skip replay hits immediately**: emit no event and rewrite no records. Before skipping, compare inputHash; on mismatch, fail the run loudly as a
 *    purity violation. This comparison is **defensive** (the report derives from a value already fixed by the journal),
 *    but it is free, and a mismatch here means the entire replay is unreliable—the Results panel must never show it without warning.
 * 3. **Check limits before persistence**: exceeding the per-item byte limit, item count, or run-level byte total raises `ReportCapExceeded`
 *    and fails the entire run.
 *    This is run-level rather than node-level because `report` returns `void` and has no rejection channel.
 * 4. **Write once**: `completed`, with no actor field.
 */
export function publishReport(
  state: EngineState,
  siteId: string,
  item: unknown,
  artifactId?: string,
): void {
  if (state.isRunSettled()) return; // Same as log: do not accept after settlement.
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const serialized = probeReportItem(state, instance, item);
  if (serialized === undefined) return; // The probe already failed the run.
  // inputHash intentionally covers **only the item**, not its label: the label is a compile-time
  // literal at the site, and resume requires byte-identical script text (script_hash), so a label
  // at the same (siteId, ordinal) cannot change. Including it in the hash would only make **every**
  // existing untagged report in the journal fail resume with InputHashMismatch—a destructive
  // payload change with no benefit.
  const hash = inputHash(item);

  // Compare hashes only; do not read the item (docs/execution-engine.md, “Reading the journal”): replaying a script with 65,536 reports would otherwise
  // decode and discard an item up to 1 MiB on every cache hit, paying the cost of all serialized bytes.
  const recorded = state.journal.getNode(state.runId, siteId, ordinal, { withResult: false });
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // Replay deduplication: silently skip (no event, no duplicate append).
  }

  // A present label must already be declared as a **preset** artifact. Check this before caps: a
  // label pointing to a nonexistent dashboard is a script error, not a capacity event; mixing the
  // two would make the error code misleading.
  // Use failRun rather than rejection for the same reason as the two report caps: void has no
  // rejection channel.
  if (artifactId !== undefined && !isDeclaredPreset(state, artifactId)) {
    state.failRun(
      new WorkflowError(
        "ArtifactUndeclared",
        `report() tag "${artifactId}" is not a declared preset artifact ` +
          `(at ${refToString(instance)}). Declare it once at the top of the script, e.g. ` +
          `artifact.chart("${artifactId}", …), before tagging reports with it. Declared presets: ` +
          `${declaredPresetIds(state).join(", ") || "(none)"}.`,
      ),
    );
    return;
  }

  if (!reserveReport(state, instance, serialized)) return;
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "report",
    inputHash: hash,
    status: "completed",
    result: item,
    // A tagged report row implements the invariant “dashboard = projection of the journal”: each
    // point on a dashboard is one row with kind = report ∧ artifact_id = that ID.
    ...(artifactId === undefined ? {} : { artifactId }),
  });
  state.record({
    type: "report",
    instance,
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

/**
 * **Runtime JSON guard** for report (the compile-time serializability diagnostic is the suspenders;
 * this is the belt). Return the serialized item; if it cannot be represented, fail the run and
 * return undefined.
 *
 * Why `JSON.stringify` instead of `canonicalJson`: canonicalJson is **total** (silently folds
 * undefined/functions into `"null"` and recurses to stack overflow on cycles), which is useful for
 * hash input, but as a guard it would silently store an incomplete item in the journal.
 * `JSON.stringify` behaves differently: cycles and bigint throw, while undefined/functions/symbols
 * return undefined—both cases can be caught and turned into a loud failure.
 *
 * Choose `DriverError` rather than `ReportCapExceeded`: this is not a cap (the cap is about count),
 * but a violation of the “item is JSON” contract whose front door is the compile-time diagnostic.
 * Reaching this point means something bypassed that check (typically a cycle created through
 * `any`), so this is a contract breach rather than a capacity event. Keep `ReportCapExceeded` for
 * cap violations so readers can act on the code.
 */
function probeReportItem(
  state: EngineState,
  instance: InstanceRef,
  item: unknown,
): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(item);
  } catch (cause) {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item cannot be serialized to JSON (a cycle or a bigint) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
        { cause },
      ),
    );
    return undefined;
  }
  if (serialized === undefined) {
    // JSON.stringify returns undefined for undefined / functions / symbols.
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item is not a JSON value (undefined, a function or a symbol) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
      ),
    );
    return undefined;
  }
  return serialized;
}

/**
 * The three report limits (per-item bytes, item count, and run-level byte total). Exceeding any of them calls failRun and returns false.
 *
 * Check in the order that identifies the failure: an oversized item is a problem with that item, regardless of how much the run has accumulated, so check it first;
 * then check the two run-level limits, both before incrementing counters so a rejected item is excluded and failure messages report accurate counts.
 */
function reserveReport(state: EngineState, instance: InstanceRef, serialized: string): boolean {
  const bytes = utf8ByteLength(serialized);
  if (bytes > REPORT_CAPS.maxItemSerializedBytes) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} is ${bytes} bytes, over the ` +
          `${REPORT_CAPS.maxItemSerializedBytes}-byte limit. Report a summary instead.`,
      ),
    );
    return false;
  }
  const tally = state.reportTally();
  if (tally.count >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  if (tally.bytes + bytes > REPORT_CAPS.maxBytesPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} would take this run's reports to ` +
          `${tally.bytes + bytes} bytes, over the ${REPORT_CAPS.maxBytesPerRun}-byte limit per run. ` +
          `Report summaries, and publish large results with artifact.file.`,
      ),
    );
    return false;
  }
  state.countReport(bytes);
  return true;
}

/**
 * UTF-8 byte length of a string (the unit for the per-item report cap). Use `TextEncoder` (a
 * standard ECMAScript/WHATWG global) instead of `Buffer.byteLength` to keep this package free of
 * Node built-in dependencies. The cap is about **bytes**, not characters: Chinese findings use
 * about three bytes per character, so counting characters would make the limit ineffective.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
