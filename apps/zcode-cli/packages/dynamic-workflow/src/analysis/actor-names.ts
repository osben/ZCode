/**
 * Compile-time courtesy diagnostics for duplicate names on named actors.
 *
 * The rule itself is **runtime-enforced**: createActor checks for duplicate nonempty effective
 * names and fails the run on collision (`DuplicateActorName`). Named actors are identity keys for
 * cache import during amend-resume, and every run may become a predecessor for a future revision;
 * duplicate names in the predecessor make import matching ambiguous.
 *
 * This handles the **portion visible through literals**, in two clauses:
 *
 * 1. **Same name at two sites**: when two `agent(...)` sites have the same string-literal effective
 *    name, report a location-specific diagnostic at the latter site so the author can rename it
 *    cheaply instead of failing halfway through execution. Skip any dynamic component
 *    (`` `worker-${i}` ``, identifiers, spreads, shorthand properties); only runtime can inspect those.
 * 2. **Static name inside fan-out**: an `agent("x")` site in a fan-out body creates a new actor for
 *    every element, all with the same name—one site, N duplicates, guaranteed runtime failure.
 *
 * Clause 1 **can miss but cannot falsely report**: skipping a potentially duplicate site has no cost
 * (the engine catches it), while falsely flagging a valid script blocks submission.
 *
 * A `.map` collection may contain <=1 element, in which case the script is valid at runtime, so
 * this clause can theoretically report falsely. The cost is asymmetric: the fix is free (use a
 * per-element name such as `` `x-${item}` `` or leave it anonymous), while suppressing the warning
 * costs the model an entire run to learn the rule. `paths.map((p) => agent("reviewer").ask(…))` is
 * the textbook fan-out pattern; silently leaving it to runtime is the worst outcome.
 *
 * Determine fan-out by **reusing the site table's classification** (`IterationCandidate` in
 * `analysis/sites.ts`: array methods with inline callbacks + `for...of`), rather than inventing
 * another loop detector. The tradeoff is that ordinary `for`/`while`/`do` loops are not in that
 * classification and are not covered by this clause; they fall back to clause 1 (invisible here,
 * left to runtime), which is a miss consistent with this module's conservative approach.
 *
 * Both CreateWorkflow and SaveWorkflow handlers first call `analyzeScript` (this diagnostic is in
 * the authoring phase of `analyzeWorkflowScript`); `!ok` returns early with diagnostics and
 * **without submitting or writing to disk**, so 9005/9006 block submission and saving. However,
 * `compileOnce` in the run service (recompilation on submit and resume) rechecks only typecheck,
 * schema, and world.run literals—not this diagnostic. Thus this is not a mandatory submit-path gate
 * and must not be treated as a load-bearing constraint: runtime duplicate detection in
 * createActor remains authoritative for name uniqueness.
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Same literal name at two sites (clause 1). 9001 = facade-siting, 9002 = schema, 9003 = world-run, 9004 = phase. */
export const DUPLICATE_ACTOR_NAME_CODE = 9005;

/**
 * Static name inside a fan-out body (clause 2), with its own code instead of reusing 9005.
 *
 * Both clauses implement the same rule but have **different certainty**: 9005 appears only when
 * duplicate names are statically certain; 9006 is the clause that deliberately accepts false
 * positives. Readers therefore need to distinguish them, especially analysis fixture corpora:
 * those scripts are never executed and exist only to pin graph shape, where static name + fan-out
 * is exactly the shape (**ActorNode.family**, actor labels) the analyzer must handle correctly.
 * Thus fixtures exempt 9006 but remain strict for 9005. A shared code would require matching
 * message text, which this repository forbids for branching on errors.
 */
export const FANOUT_ACTOR_NAME_CODE = 9006;

/**
 * Collect diagnostics for duplicate literal names. Any result means the script cannot be submitted
 * (alongside compile-time rules for `analyzeWorkflowScript`, world.run, and phase).
 */
export function collectDuplicateActorNames(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const claimed = new Map<string, ts.CallExpression>();
  // Fan-out bodies come from the site table's IterationCandidate (inline callback bodies of array
  // methods + for...of loop bodies), using the same concept as `ActorNode.fanOutId` for determining
  // whether a site is inside fan-out.
  const fanOutBodies = new Set<ts.Node>(table.iterations.map((iteration) => iteration.body));
  for (const site of table.actors) {
    // Do **not** use `site.name` from the site table here: it falls back to the binding name
    // (`const planner = agent()` becomes "planner"), which is a display label for the graph, not
    // the runtime effective name. Read the argument directly to get the value the engine sees.
    const name = staticEffectiveName(site.call);
    if (name === undefined || name === "") continue;
    const first = claimed.get(name);
    if (first === undefined) claimed.set(name, site.call);
    const loc = workflow.toScriptLoc(site.call.getStart(workflow.scriptFile));
    // Report at most once per site: the fan-out clause is more specific (and has a different fix—
    // per-element names instead of renaming), so it takes precedence. Still register the name so a
    // later duplicate site is reported normally.
    if (isInsideFanOut(site.call, fanOutBodies)) {
      diagnostics.push({
        code: FANOUT_ACTOR_NAME_CODE,
        column: loc.column,
        line: loc.line,
        message:
          `this agent(...) runs once per element of a fan-out but its name "${name}" is a fixed ` +
          `string, so every element creates a different actor under the same name — the run ` +
          `fails with DuplicateActorName as soon as the collection holds more than one item. ` +
          `An actor name must be unique within a run: it is the identity key an amended re-run ` +
          `matches its imported cache against. Build a per-element name (\`${name}-\${item}\`), ` +
          `or drop the name — anonymous actors are legal (they just never reuse cached work).`,
      });
      continue;
    }
    if (first === undefined) continue;
    // Place the diagnostic at the **later site**: the first name is already established, so the later one should change.
    const firstLoc = workflow.toScriptLoc(first.getStart(workflow.scriptFile));
    diagnostics.push({
      code: DUPLICATE_ACTOR_NAME_CODE,
      column: loc.column,
      line: loc.line,
      message:
        `two actors are named "${name}" (the first is on line ${firstLoc.line}): an actor name ` +
        `must be unique within a run. The name is the identity key an amended re-run matches ` +
        `its imported cache against, and any run can become the predecessor of one, so a ` +
        `repeated name makes that match ambiguous. Give this one its own name, or drop the ` +
        `name entirely — anonymous actors are legal (they just never reuse cached work).`,
    });
  }
  return diagnostics;
}

/**
 * Whether this call is **lexically** inside a fan-out body. Walk up its parent chain (the call may
 * itself be the body, as with the concise arrow body of `paths.map((p) => agent("x"))`); any
 * candidate body match is sufficient.
 */
function isInsideFanOut(call: ts.CallExpression, fanOutBodies: ReadonlySet<ts.Node>): boolean {
  for (let node: ts.Node | undefined = call; node !== undefined; node = node.parent) {
    if (fanOutBodies.has(node)) return true;
  }
  return false;
}

/**
 * Statically known **effective name** of an `agent(...)` call, or undefined (= skip).
 *
 * Same rule as the engine's `normalizePersona`: persona.name overrides the name argument; a
 * string persona is a system prompt and has no name. If any part is not statically knowable, skip
 * the whole check—prefer a missed warning.
 *
 * The facade's `AgentPersona` **does not declare name today**, so script-defined personas never
 * carry a name and the effective name always comes from the name argument. This persona logic
 * therefore never triggers today; it remains to stay aligned with normalizePersona, not to affect
 * current behavior. If the facade later adds name while this code still checks only the argument,
 * an actor renamed by persona could be **falsely reported**, blocking valid scripts (misses are
 * harmless because runtime catches them).
 */
function staticEffectiveName(call: ts.CallExpression): string | undefined {
  const [nameArg, personaArg] = call.arguments;
  if (personaArg !== undefined && !ts.isStringLiteralLike(personaArg)) {
    if (!ts.isObjectLiteralExpression(personaArg)) return undefined; // Dynamic persona may have a name.
    for (const property of personaArg.properties) {
      // A spread could introduce name; this is not statically knowable.
      if (ts.isSpreadAssignment(property)) return undefined;
      // A computed key (`{ ["na" + "me"]: ... }`) is also uncertain: it **could be** name. Abandon
      // the whole check instead of `continue`; continuing would fall back to the name argument and
      // assume persona did not rename the actor. That guess could falsely report and block a valid script.
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name === undefined || !isNameKey(property.name)) continue;
      if (!ts.isPropertyAssignment(property)) return undefined; // Shorthand/method: dynamic.
      return ts.isStringLiteralLike(property.initializer)
        ? property.initializer.text
        : undefined;
    }
    // No name in the object literal; fall back to the name argument.
  }
  return nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : undefined;
}

/** Whether the property key is **statically known** to be `name` (computed keys are skipped at the call site). */
function isNameKey(key: ts.PropertyName): boolean {
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "name";
}
