/**
 * Primary marking for artifacts: at most one ID per run can carry this marker.
 * Content members and preset members share the same admission criteria.
 *
 * These functions only read `state.artifacts`; they do not persist data or emit events. State is
 * derived from the journal and remains consistent after resume.
 * Callers use the criteria to decide whether to reject publication or fail the entire run.
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
