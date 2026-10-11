/**
 * Structured engine errors (docs/execution-engine.md, “Errors are first-class”): stable error codes,
 * their serializable representation, and {@link WorkflowError} itself, thrown across Boundary A.
 *
 * Split into its own file for the same reason as run-terminal.ts: types.ts had reached oxlint's 400-line limit, and this family
 * is self-contained—it depends only on the schema's `Violation` and terminal details, not on anything else in the vocabulary.
 * Consumers still import from types.ts by convention (it re-exports these types unchanged), so no import paths need to change.
 */

import type { Violation } from "../schema/types.js";
import type { ProviderStopDetails } from "./run-terminal.js";

/**
 * Stable error codes. Distinguish node-level errors (reject one ask promise) from run-level errors (fail the entire run):
 * - Node-level: ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded—a world read exceeded its operation's limit (`files.grep`: 2,000 matches or
 *   256 KB serialized, whichever comes first; `git.diff`: 512 KB; see `facade/world-read-caps.ts`). This is node-level
 *   rather than run-level because of the **rejection channel**, not severity: a world read returns a promise the script can `catch`,
 *   so “narrow the pattern or add a glob” is a real recovery path for scripts. It is intentionally **not** folded into
 *   DriverError—the limit lets a script revise its own contract, while distinguishing them by matching message text
 *   is exactly what this union type is meant to prevent.
 * - Run-level: InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName—two createActor calls in one run resolve to the same **non-empty** effective name
 *   (effective name = `spec.name` after normalizePersona; persona.name takes precedence over the name argument). This applies to
 *   **all** runs, not only amended runs: named actors are identity keys for amend-resume cache imports, and any
 *   run may become a predecessor for a future amendment; duplicate names in a predecessor make import matching ambiguous (the
 *   “engine naming uniqueness” row in docs/execution-engine.md). Anonymous names (missing or empty) are neither checked nor forbidden—the tradeoff is no cache eligibility.
 *   Literal duplicate names also get a compile-time courtesy diagnostic (analysis/actor-names.ts), but only runtime can check dynamic names,
 *   so this is the actual guard.
 *   ReportCapExceeded—a run exceeds 65,536 reports, one serialized item exceeds 1 MiB, or all items exceed 1 GiB
 *   (see `facade/report-caps.ts`). It is run-level rather than node-level, the same boundary as WorldReadCapExceeded but with the opposite result:
 *   `report` returns `void`, so the script has **no** catchable channel and the error has nowhere to go except the run.
 *   For that reason, both limits must be high enough that a reasonable script never reaches them—the author has no recovery path.
 *   It is also intentionally not folded into DriverError: the limit lets the script revise its own contract.
 * - Construction-time (run has not started; engine constructor throws synchronously): ScriptHashMismatch
 * - Host-level (**never emitted by the engine**): Interrupted—the process owning the run ended before settlement, so the host reconciles the row
 *   stuck in running during the next construction (`bootstrap/src/app/dynamic-workflow-run-service.ts` orphan reconciliation, desktop bug observed 2026-08-19).
 *   This must have a **distinct code** rather than reuse DriverError: script-thrown exceptions also become DriverError (`dynamic-workflow-runtime/src/harness.ts:311`),
 *   and sharing a code would force “process killed” and “script failed” to be distinguished by message text—the exact problem this union type prevents.
 *   ProviderStop—a subagent (or tool-side) model request encounters a **deterministic** model error (invalid authentication,
 *   model not included in the plan, quota exhausted, etc.; see the policy table in docs/execution-engine.md), and the driver stops
 *   the run as `stopped(provider)` instead of failing a node; structured details are in `providerStop`. This is another host-level case:
 *   the engine only persists it unchanged in `stop("provider", error)`.
 * Always use these codes for control-flow decisions; never match error text.
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
  // ——————————— User-facing artifacts (docs/dynamic-workflow/authoring.md, “Publishing content”) ———————————
  // ⚠ Terminology: these artifacts are all **user-facing outputs** published by scripts, unrelated to
  // `RunSettlement.artifact` (the top-level return value).
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
  // A second ID tries to become primary (docs/dynamic-workflow/authoring.md, “Ids, tags and versions”): content members cause a node-level rejection,
  // while declared members fail the run—the same boundary as above.
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
