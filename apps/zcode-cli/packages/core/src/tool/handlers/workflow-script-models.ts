// ============================================================
// Models named by a script: resolve them into a binding table and report unresolved names as 9011 (shared by CreateWorkflow / AmendWorkflow / direct start / GUI configuration).
// ============================================================
// See docs/dynamic-workflow/launch.md, “Models the script names,” and
// docs/dynamic-workflow/authoring.md「Choosing a model per subagent」。
//
// The compiler ensures script-named models passed to subagents form a closed set (9010), returned as `modelReferences`.
// This handles the part the compiler cannot: resolve each name against the **local** model catalog:
//
//   - `resolveInput` writes resolved names into input `model_bindings` (literal name → canonical ID);
//   - `prepareApproval` skips the dialog if any name is unbound;
//   - the handler reports unbound names as 9011 diagnostics, following the “does not compile” path (file/line, edit the file, resubmit `path`).
//
// An unresolved name is **not** a business failure of the call (unlike an unresolved `subagent_model`): it is written in the script, so
// the script file must be edited. Its error should therefore look just like a compile error, not a request for the model to change a parameter.

import {
  MODEL_UNRESOLVED_CODE,
  type AnalyzeResult,
  type ModelReference,
} from "@zcode/dynamic-workflow";
import type { CreateWorkflowDiagnostic, ModelCatalogPort, ModelSelection } from "@zcode/contracts";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import type { ToolInputResolutionResult } from "../types.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { resolveModelReference } from "./model-reference.js";

/** Name → canonical ID `providerId/modelId[$level]`. */
export type ScriptModelBindings = Record<string, string>;

/** The 9011 message for each name when the host has no model catalog (the fix belongs in the script, not the parameters). */
export const SCRIPT_MODELS_UNAVAILABLE =
  "This host cannot choose models; remove `model` from the personas (the subagents then run on the run's subagent model).";

/**
 * Result of resolving one name. If `inherited` is present, the binding came from a predecessor (`AmendWorkflow` / GUI configuration):
 * that branch resolves the canonical ID recorded by the predecessor, so its failure message must say “the inherited model is gone”; otherwise the model may change a name it did not get wrong.
 */
type NameResolution = { ok: true; canonical: string } | { ok: false; message: string };

function resolveName(
  name: string,
  catalog: ModelCatalogPort | undefined,
  inherited: ScriptModelBindings | undefined,
): NameResolution {
  if (catalog === undefined) return { ok: false, message: SCRIPT_MODELS_UNAVAILABLE };
  const entries = catalog.listModels();
  const previous = inherited?.[name];
  if (previous !== undefined) {
    // Inherit the predecessor's binding: resolve the canonical ID it recorded (first match), not the name itself—a user may have changed
    // the model for this name in the predecessor's confirmation dialog, and resolving the name again would silently undo that choice.
    const resolution = resolveModelReference(previous, entries);
    if (resolution.ok) return { ok: true, canonical: resolution.canonical };
    return {
      ok: false,
      message: `"${name}" keeps the model the amended run bound it to, ${previous}, which cannot be used now. ${resolution.message}`,
    };
  }
  const resolution = resolveModelReference(name, entries);
  if (resolution.ok) return { ok: true, canonical: resolution.canonical };
  return {
    ok: false,
    message: `The model "${name}" named in the script cannot be used: ${resolution.message}`,
  };
}

/** Deduplicated names in first-occurrence order (used to render dialog rows and list names in result copy). */
export function distinctModelNames(references: readonly ModelReference[]): string[] {
  return [...new Set(references.map((reference) => reference.name))];
}

/**
 * Resolve each model name named by the script into a binding table. Include only resolved names; unresolved names stay out of the table—
 * `prepareApproval` and the handler both check whether any names are unbound, so failures need no second representation.
 */
export function resolveScriptModelBindings(
  names: readonly string[],
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ScriptModelBindings {
  const bindings: ScriptModelBindings = {};
  for (const name of names) {
    const resolution = resolveName(name, catalog, inherited);
    if (resolution.ok) bindings[name] = resolution.canonical;
  }
  return bindings;
}

/**
 * Final step in `resolveInput`: compile the normalized script (the single-slot cache makes the next two compilations free) and write `model_bindings`
 * into input. **Always overwrite** the model-supplied value (as with `adjustable_settings`, fabricating it has no effect); omit the entire key if the script fails to compile or names no models.
 */
export function withScriptModelBindings(
  input: Record<string, unknown>,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): Record<string, unknown> {
  const { model_bindings: _forged, ...rest } = input;
  void _forged;
  const script = rest.script;
  if (typeof script !== "string") return rest;
  const analysis = analyzeScript(script);
  if (!analysis.ok) return rest;
  const names = distinctModelNames(analysis.modelReferences);
  if (names.length === 0) return rest;
  const bindings = resolveScriptModelBindings(names, catalog, inherited);
  return Object.keys(bindings).length === 0 ? rest : { ...rest, model_bindings: bindings };
}

/** Apply {@link withScriptModelBindings} to a normalized result: pass failures through unchanged and add the binding table to successful input. */
export function withScriptModelBindingsResolved(
  resolution: ToolInputResolutionResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ToolInputResolutionResult {
  if (!resolution.result) return resolution;
  const input = resolution.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return resolution;
  return {
    result: true,
    input: withScriptModelBindings(input as Record<string, unknown>, catalog, inherited),
  };
}

/** Binding table in input (written by `resolveInput`; treat it as absent if a hook corrupts its shape). */
export function readScriptModelBindings(input: unknown): ScriptModelBindings {
  if (typeof input !== "object" || input === null) return {};
  const raw = (input as { model_bindings?: unknown }).model_bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const bindings: ScriptModelBindings = {};
  for (const [name, canonical] of Object.entries(raw)) {
    if (typeof canonical === "string") bindings[name] = canonical;
  }
  return bindings;
}

/** Whether all names named by the script have bindings (`prepareApproval` uses this to decide whether to open the dialog). */
export function allScriptModelsBound(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
): boolean {
  return analysis.modelReferences.every((reference) => bindings[reference.name] !== undefined);
}

/**
 * Unbound names → 9011 diagnostics, **one per name**, at its first occurrence. Reporting every occurrence would repeat a candidate list up to forty lines long N times;
 * the model fixes the name, so one diagnostic is enough. Generate the message by resolving again (the handler has the catalog),
 * so `resolveInput` does not need to store failure copy in input.
 */
export function unresolvedScriptModelDiagnostics(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): CreateWorkflowDiagnostic[] {
  const diagnostics: CreateWorkflowDiagnostic[] = [];
  const reported = new Set<string>();
  for (const reference of analysis.modelReferences) {
    if (bindings[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    const resolution = resolveName(reference.name, catalog, inherited);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      // If it resolves here, the catalog must have changed since resolveInput (for example, the provider was just re-added). Still report it:
      // the user's approved dialog (or the fact that no dialog opened) did not include this model, so silently using it would be an unseen choice.
      message: resolution.ok
        ? `The model "${reference.name}" became available only after this call was checked; submit the script again.`
        : resolution.message,
    });
  }
  return diagnostics;
}

/** Binding table → structured selections expected by the port. An unresolvable canonical ID indicates a wiring error (`resolveInput` guarantees resolution). */
export function scriptModelSelections(
  bindings: ScriptModelBindings,
): Record<string, ModelSelection> | undefined {
  const names = Object.keys(bindings);
  if (names.length === 0) return undefined;
  const selections: Record<string, ModelSelection> = {};
  for (const name of names) {
    try {
      selections[name] = parseModelPickerValue(bindings[name]!);
    } catch (cause) {
      throw new Error(`workflow model_bindings reached the handler un-canonicalised: ${name}`, {
        cause,
      });
    }
  }
  return selections;
}

/**
 * Sentence in the result copy (docs/dynamic-workflow/launch.md, “Models the script names”): report canonical IDs that
 * the model can paste into the next call unchanged. Include only when the table is nonempty; prefix with a space after the settings sentence.
 */
export function describeScriptModelBindings(bindings: ScriptModelBindings): string {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return "";
  const pairs = entries.map(([name, canonical]) => `"${name}" = ${canonical}`);
  return ` Models named in the script: ${pairs.join("; ")}.`;
}

/**
 * Complete the two launch paths without a confirmation dialog (direct coordinator start and GUI configuration) in one step: resolve all names and return both
 * the selections required by the port and 9011 diagnostics for unbound names. When `unbound` is nonempty, the caller rejects and does not use `selections`.
 */
export function bindScriptModels(
  analysis: AnalyzeResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): {
  selections: Record<string, ModelSelection> | undefined;
  unbound: CreateWorkflowDiagnostic[];
} {
  const bindings = resolveScriptModelBindings(
    distinctModelNames(analysis.modelReferences),
    catalog,
    inherited,
  );
  const unbound = unresolvedScriptModelDiagnostics(analysis, bindings, catalog, inherited);
  return { selections: unbound.length > 0 ? undefined : scriptModelSelections(bindings), unbound };
}
