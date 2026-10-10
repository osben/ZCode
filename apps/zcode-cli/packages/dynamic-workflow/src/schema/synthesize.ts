import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import { collectSites, type SiteTable } from "../analysis/sites.js";
import { createWorkflowProgram, collectDiagnostics } from "../compiler/compile.js";
// AskSpec is part of the engine's input vocabulary; import it as a type only (erased at compile
// time, with no runtime edge). The engine also imports schema's Violation as a type only—both
// directions are type-only, so there is no import cycle.
import type { AskSpec } from "../engine/types.js";
import { SchemaEmitter, SchemaRejection } from "./emit.js";
import { harvestConstraints, mergeConstraints } from "./jsdoc.js";
import type { JsonSchema } from "./types.js";
import { SCHEMA_DIAGNOSTIC_CODE } from "./types.js";

/**
 * Schema synthesis (compile side): for each typed ask site, emit its result type T as plain JSON
 * Schema using the checker's structured view, grouped by site ID (such as `ask#1`).
 *
 * “Typed” means an ask explicitly has a type argument `x.ask<T>(...)` and T does not resolve to
 * the primitive `string`. Both `ask()` and `ask<string>()` are untyped asks (their result is the
 * final text, so no schema is emitted). Reject unserializable T with a diagnostic pointing to the
 * ask site (reusing the analysis pipeline's CompileDiagnostic shape).
 *
 * The same pass also checks whether `report(item)` arguments are serializable, using the same
 * emitter and diagnostic channel; see {@link reportItemDiagnostics} for rationale. Report sites do
 * **not** produce schemas; they only contribute diagnostics.
 */

export interface SchemaSynthesisResult {
  /** JSON Schema for each typed ask site, grouped by site ID. */
  schemas: Record<string, JsonSchema>;
  /** Rejection diagnostic located at the corresponding ask site. */
  diagnostics: CompileDiagnostic[];
}

/**
 * Result type T for an ask site, or undefined for an untyped ask. This is the single source of truth
 * for typed-ask detection: the site table (analysis/sites.ts) stores only `call: ts.CallExpression`
 * without a typed marker, so resolve it from the checker here. Untyped means T resolves to the
 * primitive `string` (`ask()` with its default type argument and explicit `ask<string>()` both fit;
 * `type A = string; ask<A>()` also resolves to primitive string in the checker).
 *
 * Keep this private to the module: downstream (lowering/engine/driver) needs no separate predicate.
 * A successfully started run has no diagnostics, so `siteId in schemas` determines whether an ask
 * is typed. But **do not** use schema keys to construct the engine's askSpecs: that would omit
 * untyped sites entirely, and the engine treats an omission as a wiring error and fails. Always
 * build askSpecs through {@link buildAskSpecs} (iterate the site table).
 */
function askResultType(checker: ts.TypeChecker, call: ts.CallExpression): ts.Type | undefined {
  const typeNode = call.typeArguments?.[0];
  if (typeNode === undefined) return undefined;
  const type = checker.getTypeFromTypeNode(typeNode);
  return (type.flags & ts.TypeFlags.String) !== 0 ? undefined : type;
}

/**
 * Main entry point: emit a schema for every typed ask using the same checker as site-table
 * construction. This corresponds to `synthesizeAskSchemas(program, siteTable)` in the docs; here
 * it accepts {@link WorkflowProgram} to access `toScriptLoc` for located diagnostics.
 */
export function synthesizeAskSchemas(
  workflow: WorkflowProgram,
  table: SiteTable,
): SchemaSynthesisResult {
  const checker = workflow.program.getTypeChecker();
  const schemas: Record<string, JsonSchema> = {};
  const diagnostics: CompileDiagnostic[] = [];

  for (const site of table.asks) {
    const type = askResultType(checker, site.call);
    if (type === undefined) continue; // Untyped ask: the result is final text, so emit no schema.

    try {
      const typeNode = site.call.typeArguments![0]!;
      const emitter = new SchemaEmitter(checker, typeNode);
      schemas[site.id] = attachTopDoc(emitter.emitTop(type), type, checker);
    } catch (error) {
      if (!(error instanceof SchemaRejection)) throw error;
      diagnostics.push({
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "ask result type"),
      });
    }
  }

  for (const site of table.reports) diagnostics.push(...reportItemDiagnostics(checker, site));

  return { diagnostics, schemas };
}

/**
 * Check whether the `report(item)` argument is serializable.
 *
 * Why this shares the **same checker walk, emitter, and diagnostic channel** as ask-schema
 * synthesis: a reported item and an artifact cross the journal and protocol boundaries for exactly
 * the same reason, so “what is serializable” must have one answer. A parallel checker would create
 * a second source of truth—and when they diverged, a run's Results panel would show `{}`.
 *
 * Two differences from ask:
 *   1. **No schema is emitted.** report has no validation target—there is no model submission to
 *      validate; the item is computed by the script. Only the yes/no serializability check matters,
 *      so discard the emitted schema.
 *   2. The type comes from the **argument expression**, not a type argument. The facade declares
 *      the parameter as `unknown` (`unknown` is valid any-JSON to the emitter), so the question is
 *      “what is the type of the value you actually passed?” In `report(x)`, `unknown` or an ordinary
 *      JSON shape passes, while `Date`/function/class instance/Promise is rejected at the call site.
 */
function reportItemDiagnostics(
  checker: ts.TypeChecker,
  site: SiteTable["reports"][number],
): CompileDiagnostic[] {
  // typecheck reports a missing argument (the facade's `item` parameter is required); nothing to do here.
  if (site.item === undefined) return [];
  try {
    new SchemaEmitter(checker, site.item).emitTop(checker.getTypeAtLocation(site.item));
    return [];
  } catch (error) {
    if (!(error instanceof SchemaRejection)) throw error;
    return [
      {
        code: SCHEMA_DIAGNOSTIC_CODE,
        column: site.loc.column,
        line: site.loc.line,
        message: rejectionMessage(error, "report item type"),
      },
    ];
  }
}

/**
 * Convenience entry point for end-to-end synthesis from script text (typecheck → site table →
 * synthesis). Gives package/engine callers a way to avoid assembling program+table themselves;
 * analyzeWorkflowScript belongs to the analysis domain and is not touched here.
 * If the script itself fails typecheck, return its compile diagnostics without synthesis.
 */
export function synthesizeWorkflowSchemas(scriptText: string): SchemaSynthesisResult {
  const workflow = createWorkflowProgram(scriptText);
  const compileDiagnostics = collectDiagnostics(workflow.program);
  if (compileDiagnostics.length > 0) return { diagnostics: compileDiagnostics, schemas: {} };
  return synthesizeAskSchemas(workflow, collectSites(workflow));
}

/**
 * Assemble the site table and synthesized schemas into the engine's `askSpecs`.
 *
 * **Why iterate `table.asks` rather than keys in `schemas`**: schemas are emitted only for typed
 * sites (an untyped ask returns final-turn text and has no schema), while the engine requires
 * askSpecs to cover **every** ask site. A missing site is a hard wiring failure (`MissingAskSpec`),
 * because the site table and schema synthesis came from the same compile and an omission can only
 * mean artifacts from separate runs were combined. Therefore, explicitly mark untyped sites as
 * `{ typed: false }` rather than using the fallback “if no schema, assume untyped.” That fallback
 * would silently downgrade typed asks—no submit_result registration, final-turn text used as the
 * result, and schema validation lost entirely.
 *
 * This correctness-critical construction has only one valid form, so keep it in one place: callers
 * (run service, test setup) must use it rather than implement their own. The site table is the
 * single source of identity; schema keys that do not match any site are ignored.
 */
export function buildAskSpecs(table: SiteTable, schemas: Record<string, JsonSchema>): Map<string, AskSpec> {
  const specs = new Map<string, AskSpec>();
  for (const site of table.asks) {
    const schema = schemas[site.id];
    specs.set(site.id, schema === undefined ? { typed: false } : { typed: true, schema });
  }
  return specs;
}

/** Description/constraints for the top-level type, taken from its alias or symbol (named interface/type alias). */
function attachTopDoc(schema: JsonSchema, type: ts.Type, checker: ts.TypeChecker): JsonSchema {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined) return schema;
  return mergeConstraints(schema, harvestConstraints(symbol, checker));
}

function rejectionMessage(error: SchemaRejection, subject: string): string {
  const where = error.path !== "$" && error.path.length > 0 ? ` (at ${error.path})` : "";
  return `unsupported ${subject}: ${error.reason}${where}`;
}
