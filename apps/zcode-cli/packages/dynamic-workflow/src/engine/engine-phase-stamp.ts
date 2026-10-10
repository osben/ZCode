/**
 * Read and stamp the phase at which an instance was created.
 * Two read paths share `instancePhases` (instance `siteId@ordinal` → phase name at creation): add
 * phase data to events and add phase data to `ProviderStop` details.
 * The engine owns the map and writes it when instances are created; this module only reads it.
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
  return event;
}

/**
 * Add the **creation phase** of the subagent that triggered a `ProviderStop`: the driver knows only
 * the actor ref, while the engine knows the phase from the same map used for `phaseName` on events.
 * Return unchanged if there is no providerStop, no subagent, a phase is already present, or the ref
 * was created before any `phase()` marker.
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
