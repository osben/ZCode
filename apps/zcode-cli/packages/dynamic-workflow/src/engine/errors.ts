/**
 * Structured engine errors: stable error codes, serializable shapes, and {@link WorkflowError},
 * which is thrown across Boundary A. This module depends on the schema's Violation and terminal
 * details; types.ts re-exports these types for callers.
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
 * Stable error codes. Distinguishes node-level errors (reject one ask's promise) from run-level
 * errors (fail the entire run):
 * - Node level: ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded—a world read exceeded its op limit (`files.grep`: 2,000 matches or 256 KB
 *   serialized, whichever comes first; `git.diff`: 512 KB; see `facade/world-read-caps.ts`). It is
 *   node-level rather than run-level because of the **rejection channel**, not severity: world reads
 *   return a promise the script can `catch`, so “narrow the pattern or add a glob” is a recovery
 *   path the script can actually take. It is also intentionally **not** folded into DriverError:
 *   the limit is a contract the script can use to rewrite its behavior, while distinguishing the
 *   two by matching message text is exactly what this union type is meant to prevent.
 * - Run level: InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName—two createActor calls in one run resolve to the same **non-empty** effective
 *   name (effective name = `spec.name` after normalizePersona, where persona.name overrides the
 *   name argument). This rule applies to **all** runs, not only amended runs: named actors are
 *   identity keys for amend-resume cache imports, and any run may become a predecessor of a future
 *   amendment, where duplicate names would make import matching ambiguous. Anonymous actors
 *   (missing or empty name) are neither checked nor forbidden; they simply cannot be cached.
 *   Literal duplicate names also get a compile-time courtesy diagnostic (analysis/actor-names.ts),
 *   but dynamic names can only be checked at runtime, so this is the real gate.
 *   ReportCapExceeded—a run exceeded 256 reports or one item's serialization exceeded 32 KB (see
 *   `facade/report-caps.ts`). This is run-level rather than node-level, the same distinction as
 *   WorldReadCapExceeded above but with the opposite result: `report` returns `void`, so the script
 *   has **no** channel it can catch; only the run can contain the failure. For that reason these
 *   limits must be high enough that a reasonable script never hits them—the author has no recovery
 *   path. It is also intentionally not folded into DriverError: the limit is a contract the script
 *   can use to revise its behavior.
 * - Construction time (before the run starts; the engine constructor throws synchronously): ScriptHashMismatch
 * - Host level (**never produced by the engine**): Interrupted—the process that owned the run exited
 *   before settlement, and the host reconciles the record left in running state during the next
 *   construction (`bootstrap/src/app/dynamic-workflow-run-service.ts` orphan reconciliation). It
 *   must have a **separate code** instead of reusing DriverError: a script-thrown error is also
 *   encoded as DriverError (`dynamic-workflow-runtime/src/harness.ts:311`), and with the same code
 *   “process killed” versus “script failed” could only be distinguished by message text—the exact
 *   problem this union type is meant to prevent.
 *   ProviderStop—a model request from a subagent (or tool side) hit a **deterministic** model-side
 *   error (invalid authentication, model not included in the plan, quota exhausted, etc.). The
 *   driver stops the run as `stopped(provider)` instead of failing the node; structured details are
 *   in `providerStop`. This is another host-level error: the engine only stores it as-is in
 *   `stop("provider", error)`.
 * Use these codes for all flow decisions; never match error text.
 */
export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  // ——————————— User-facing artifacts ———————————
  // ⚠ Terminology: these artifacts are all **user-facing outputs** published by scripts, unrelated
  // to `RunSettlement.artifact` (the top-level return value).
  //
  // The error channel splits by **member family**, using the same reasoning as the
  // WorldReadCapExceeded / ReportCapExceeded distinction: content members (`file`/`markdown`)
  // return promises that scripts can catch, so failures reject at node level. Preset members return
  // void and have nowhere to reject, so the same facts fail the run for that family. The three
  // driver-side codes (Missing/Outside/TooLarge/StoreUnavailable) can only come from content
  // members, so they are always node-level.
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  // If a second ID wants to be primary, content members reject at node level while preset members
  // fail the run, following the same distinction as above.
  | "ArtifactPrimaryConflict";

/**
 * Structured comparison for mismatched values (which side changed). The recorded value is
 * `expected`; the current input is `got`.
 * When diagnosing a rejected resume, callers need these two values rather than extracting them
 * from the message with a regex—flow decisions and display should not depend on error text.
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/** Serializable error shape stored in the journal (dwf_node.error_json / dwf_run.failure_json). */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  /** Present only when `code === "ProviderStop"`. */
  providerStop?: ProviderStopDetails;
}

/**
 * Structured error thrown across Boundary A. Includes a stable code and optional violations /
 * finalText / mismatch so script-side try/catch and callers can handle it structurally without
 * relying on string matching.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations?: Violation[];
  readonly finalText?: string;
  readonly mismatch?: WorkflowErrorMismatch;
  readonly providerStop?: ProviderStopDetails;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    extra?: {
      violations?: Violation[];
      finalText?: string;
      mismatch?: WorkflowErrorMismatch;
      providerStop?: ProviderStopDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (extra?.violations !== undefined) this.violations = extra.violations;
    if (extra?.finalText !== undefined) this.finalText = extra.finalText;
    if (extra?.mismatch !== undefined) this.mismatch = extra.mismatch;
    if (extra?.providerStop !== undefined) this.providerStop = extra.providerStop;
    if (extra?.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  /** Convert to a serializable shape for journal storage. */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    return json;
  }

  /** Reconstruct from a journal record (used when replay hits a failed node). */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
    });
  }
}
