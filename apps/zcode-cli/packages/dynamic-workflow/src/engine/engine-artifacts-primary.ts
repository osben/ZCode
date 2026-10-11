/**
 * Fix rationale: engine-artifacts.ts reached oxlint's 400-line limit. The extracted code represents
 * one complete concept—the **primary artifact flag** (`primary`). At most one ID per run may carry it
 * (docs/dynamic-workflow/authoring.md, “Ids, tags and versions”). Both content and preset members use
 * the same admission criteria, so this concept belongs in its own module rather than being scattered
 * across the publication path.
 *
 * All three functions are **pure**: they only read `state.artifacts` (derived from journal rows and
 * therefore consistent after resume). They do not persist data or emit events; callers decide whether
 * to reject or fail the run based on the result.
 */

import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString } from "./types.js";

/** Current primary ID for this run (at most one), or undefined. Derived from `state.artifacts`, so it remains consistent after resume. */
export function primaryArtifactId(state: EngineState): string | undefined {
  for (const [id, idState] of state.artifacts) if (idState.primary) return id;
  return undefined;
}

/** If `id` wants to be primary but **another** ID already is, return that ID; otherwise undefined (not a candidate or already the primary). */
export function primaryConflict(
  state: EngineState,
  id: string,
  primary: boolean,
): string | undefined {
  if (!primary) return undefined;
  const holder = primaryArtifactId(state);
  return holder === undefined || holder === id ? undefined : holder;
}

export function primaryConflictMessage(
  id: string,
  holder: string,
  fix: string,
  instance: InstanceRef | undefined,
): string {
  const where = instance === undefined ? "" : ` (at ${refToString(instance)})`;
  return (
    `Cannot mark "${id}" as primary${where}: "${holder}" is already this run's primary artifact. ` +
    `A run has one deliverable; ${fix}, or publish it as a new version of "${holder}".`
  );
}
