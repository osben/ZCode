import type { SiteGraph } from "../analysis/types.js";
import { interpret } from "../analysis/interpret.js";
import { projectSiteGraph } from "../analysis/graph.js";
import type { SiteTable } from "../analysis/sites.js";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { AskSpec } from "../engine/types.js";
import { canonicalJson } from "../engine/hash.js";
import type { JsonSchema } from "./types.js";

/**
 * **Submit profile** for each actor site: determines which `submit_result` tool the actor's subagent session receives.
 *
 * - `untyped`: every ask that can reach this actor is untyped (or it has no asks) → do not register submit_result.
 * - `mono`: schemas for **all** typed asks that can reach this actor are identical (canonical JSON
 *   equality; untyped asks may be mixed in) → tool declaration is `{ result: schema }`, frozen and
 *   unchanged across asks for this actor, so it is cache-neutral.
 * - `generic`: typed asks have more than one schema → use the existing generic tool plus a schema
 *   suffix for each ask.
 *
 * Why compile-time rather than runtime: the tool block is rendered at the start of the prompt, so
 * changing schemas per ask invalidates the actor's entire cached prefix. A typed tool is free only
 * when the schema is known to stay unchanged throughout the actor's lifetime; otherwise, fall back
 * to generic with byte-for-byte equivalent behavior.
 */
export type ActorSubmitProfile =
  | { kind: "untyped" }
  | { kind: "mono"; schema: JsonSchema }
  | { kind: "generic" };

/** Profile used when absent or indeterminate: current behavior. */
export const GENERIC_SUBMIT_PROFILE: ActorSubmitProfile = { kind: "generic" };

/**
 * Derive the submit profile for each actor site from the site graph and ask specs. Pure function.
 *
 * **Reliability rule**: derive ask→actor bindings from the may-set in the site graph
 * (`SiteNode.actors`). If **any** ask site has an empty actor set (its receiver could not be
 * resolved), the analysis cannot determine which actor receives that ask, so mark **all** actors
 * `generic`. This is intentionally conservative: if a typed ask reaches an `untyped` subagent, it
 * has no tool to submit with and can only fail after exhausting nudges. Saving some cache is not
 * worth removing the tool based on an incomplete graph. Similarly, if an ask's actor set has
 * multiple members (a receiver in a conditional branch), count its schema for every member.
 *
 * If askSpecs is missing any ask site, also fall back to generic everywhere: the site table and
 * specs came from the same compile, so an omission can only be a wiring error. Do not guess here
 * (the engine hard-fails with MissingAskSpec; this code only needs to avoid compounding it).
 *
 * The returned map covers every actor site in `graph.actors`.
 */
export function deriveActorSubmitProfiles(
  graph: SiteGraph,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  const profiles = new Map<string, ActorSubmitProfile>();
  const actorIds = graph.actors.map((actor) => actor.id);

  // Typed schemas collected for each actor, deduplicated by canonical JSON (the same schema may be
  // synthesized separately at different ask sites, producing distinct references with identical
  // content, so compare by value).
  const schemasByActor = new Map<string, Map<string, JsonSchema>>();
  for (const id of actorIds) schemasByActor.set(id, new Map());

  for (const node of graph.nodes) {
    if (node.kind !== "ask") continue;
    const actors = node.actors ?? [];
    const spec = askSpecs.get(node.id);
    if (actors.length === 0 || spec === undefined) {
      for (const id of actorIds) profiles.set(id, GENERIC_SUBMIT_PROFILE);
      return profiles;
    }
    if (!spec.typed) continue;
    const schema = spec.schema as JsonSchema;
    const key = canonicalJson(schema);
    for (const actorId of actors) {
      // Actor IDs in the site graph should always be present in graph.actors; defensively add a
      // bucket instead of silently skipping one.
      let bucket = schemasByActor.get(actorId);
      if (bucket === undefined) {
        bucket = new Map();
        schemasByActor.set(actorId, bucket);
      }
      bucket.set(key, schema);
    }
  }

  for (const [actorId, bucket] of schemasByActor) {
    if (bucket.size === 0) profiles.set(actorId, { kind: "untyped" });
    else if (bucket.size === 1)
      profiles.set(actorId, { kind: "mono", schema: [...bucket.values()][0]! });
    else profiles.set(actorId, GENERIC_SUBMIT_PROFILE);
  }
  return profiles;
}

/**
 * Convenience “compile once” entry point: interpret and project the site graph on the **same**
 * {@link WorkflowProgram} used to build the site table and synthesize schemas (the same two steps
 * run by analyzeWorkflowScript), then derive profiles. Used by the run submission path so callers
 * do not need to assemble interpret + projectSiteGraph themselves (neither is in the package's
 * public API).
 */
export function deriveActorSubmitProfilesFor(
  workflow: WorkflowProgram,
  table: SiteTable,
  askSpecs: ReadonlyMap<string, AskSpec>,
): Map<string, ActorSubmitProfile> {
  return deriveActorSubmitProfiles(projectSiteGraph(interpret(workflow, table)), askSpecs);
}
