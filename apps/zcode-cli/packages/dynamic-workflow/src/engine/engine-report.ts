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
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * Publish an intermediate result (`report` in Boundary A). Synchronous, no return value, and no
 * driver round trip: write one journal row and emit one event.
 *
 * The four steps below must stay in this order:
 *
 * 1. **Probe serialization first.** Use one `JSON.stringify` call to get both whether the item is
 *    representable as JSON and its byte length (the unit used by the cap). This must happen before
 *    canonicalJson: a circular item makes canonicalJson recurse until stack overflow, which is a
 *    crash rather than a readable failure.
 * 2. **Skip replay hits immediately**: emit no event and do not rewrite the record. Compare
 *    inputHash first; on mismatch, fail the run loudly for violating the purity contract. This is
 *    a **defensive** comparison (a report is derived from a value already fixed by the journal), but
 *    it is free, and a mismatch here means the whole replay is unreliable—Results-panel readers
 *    must never see that unknowingly.
 * 3. **Check caps before storage**: exceeding either the item count or per-item byte limit fails the
 *    entire run with `ReportCapExceeded`. It is run-level rather than node-level because `report`
 *    returns `void` and has no rejection channel.
 * 4. **One write**: `completed`, with no actor field.
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

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
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

/** The two report caps (item count and per-item bytes). Exceeding either calls failRun and returns false. */
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
  if (state.reportCount() >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  state.countReport();
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
