// ============================================================
// Saved workflows - argument validation
// ============================================================
//
// Validate **before confirmation**: bad arguments leave nothing for the user to decide, so a guaranteed-to-fail dialog would only
// interrupt the model's repair loop with an invalid decision. This is the same principle CreateWorkflow uses for scripts that do not
// compile (see `prepareApproval` in create-workflow.ts).

import type { SavedWorkflowArgDeclaration, SavedWorkflowArgsDeclaration } from "@zcode/contracts";

export type WorkflowArgsValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Validate the supplied arguments against declarations and fill in defaults.
 *
 * Collect **all** violations before returning instead of stopping at the first: if the model learns that `pr` is missing and
 * `prNumber` is extra, it can fix both at once; if it only learns `pr` is missing, it may fix that and fail again.
 *
 * Any arguments passed to a workflow without declared args are invalid: it cannot read them, and silently discarding them would make
 * the caller think they took effect.
 */
export function validateWorkflowArgs(
  declaration: SavedWorkflowArgsDeclaration | undefined,
  provided: Record<string, unknown> | undefined,
): WorkflowArgsValidation {
  const declared = declaration ?? {};
  const given = provided ?? {};
  const errors: string[] = [];
  const args: Record<string, unknown> = {};

  const declaredNames = Object.keys(declared);
  for (const key of Object.keys(given)) {
    if (declared[key] !== undefined) continue;
    errors.push(
      declaredNames.length === 0
        ? `unknown argument '${key}': this workflow declares no arguments`
        : `unknown argument '${key}' (declared: ${declaredNames.join(", ")})`,
    );
  }

  for (const [key, spec] of Object.entries(declared)) {
    const supplied = given[key];
    // Treat omitted and explicit undefined the same: JSON cannot represent undefined, so they can only mean the same thing.
    if (supplied === undefined) {
      if (spec.default !== undefined) {
        // Validate defaults and supplied values through the **same** type check. A parameter declared as number but defaulted to "3"
        // should fail when saved, not later when the script reads it.
        const failure = typeMismatch(key, spec, spec.default, "default value");
        if (failure === undefined) args[key] = spec.default;
        else errors.push(failure);
        continue;
      }
      if (spec.required === true) errors.push(`missing required argument '${key}'`);
      continue;
    }

    const failure = typeMismatch(key, spec, supplied, "value");
    if (failure === undefined) args[key] = supplied;
    else errors.push(failure);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, args };
}

/**
 * Message when the type does not match; `undefined` when it does.
 *
 * `json` accepts anything—it means “do not validate here,” so even null is a valid JSON value. Check the three primitive types with
 * typeof; `number` additionally rejects NaN and Infinity because they cannot cross the JSON boundary into the sandbox. Allowing them
 * would turn a readable error into `null` inside the script.
 */
function typeMismatch(
  key: string,
  spec: SavedWorkflowArgDeclaration,
  value: unknown,
  what: string,
): string | undefined {
  const describe = (expected: string): string =>
    `argument '${key}': expected ${expected}, got ${describeValue(value)} (${what})`;

  switch (spec.type) {
    case "string":
      return typeof value === "string" ? undefined : describe("a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : describe("a finite number");
    case "boolean":
      return typeof value === "boolean" ? undefined : describe("a boolean");
    case "json":
      return undefined;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
