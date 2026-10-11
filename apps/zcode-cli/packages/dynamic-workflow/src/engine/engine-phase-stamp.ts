/**
 * Two helpers that stamp birth-phase coordinates (docs/dynamic-workflow/presentation.md, added 2026-09-09).
 *
 * Split because engine.ts reached oxlint's 400-line limit. These two helpers were chosen because they are closely related—the only two readers
 * of the same `instancePhases` table (instance `siteId@ordinal` → its **birth phase**): one stamps events, the other adds a phase to
 * `ProviderStop` details. Both are pure functions; the caller (engine) owns the table and writes at creation time, while these helpers only read it. Only engine.ts uses them publicly.
 */

import type { RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/** Instance key (`siteId@ordinal`) → phase name at creation. Read-only view of the engine's `instancePhases`. */
export type InstancePhases = ReadonlyMap<string, string>;

/**
 * Add the creation phase to **creation events**: look up actor-created by actor and node-queued by
 * instance. Cached `node-settled { cached: true }` is also looked up by instance—a cached node has
 * no queued event, so settlement is its creation event. Return all other events **unchanged**: no
 * other scheduler emitters need changes, and the reducer carries the value forward as it already
 * does for `actorSiteId`.
 *
 * The ask's `node-dispatched` is the sole exception: it repeats its creation facts (see the event
 * of the same name in types.ts), so add both phase names here: `phaseName` by instance and
 * `actorPhaseName` by actor. Both lookups use the same creation map, so they exactly match the
 * corresponding node-queued and actor-created. Stamp only when `actor` is present—world-read
 * dispatch has no subagent and remains unchanged.
 *
 * This is not “the current phase when the event is emitted”: a hold rule may delay node-queued
 * until after the next marker even though the node was created in the previous phase; dispatch may
 * also wait behind the concurrency ceiling until the script has passed several markers.
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = instancePhases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-dispatched" && event.actor !== undefined) {
    const phaseName = instancePhases.get(refToString(event.instance));
    const actorPhaseName = instancePhases.get(refToString(event.actor));
    if (phaseName === undefined && actorPhaseName === undefined) return event;
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === "node-settled" && event.cached === true) {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  // Reaching a hole is also a birth (docs/execution-engine.md, “Holes”): its ordinal is generated like a node's and its birth
  // phase comes from the same table—there is no row, so the event is its only coordinate.
  if (event.type === "hole-reached") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * Add the triggering subagent's **birth phase** to `ProviderStop` (the `phase=` in docs/execution-engine.md,
 * “Notification copy”): the driver knows only the actor ref, while only the engine knows its phase (from the same table used for event-stream `phaseName`).
 * Return unchanged if there is no providerStop, no subagent, a phase is already present, or the ref was created before any `phase()` marker.
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
