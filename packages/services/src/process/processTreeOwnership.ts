import type { ChildProcess } from "node:child_process";
import {
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mergeIdentities(...groups: readonly (readonly ProcessIdentity[])[]): ProcessIdentity[] {
  const identitiesByPid = new Map<number, ProcessIdentity>();
  for (const identities of groups) {
    for (const identity of identities) {
      identitiesByPid.set(identity.pid, identity);
    }
  }
  return [...identitiesByPid.values()];
}

function captureLiveIdentities(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (hasChildExited(child)) {
    return [];
  }
  return [...(captureProcessTreeSnapshot(child, options)?.identities ?? [])];
}

function isSameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.processGroupId === right.processGroupId
  );
}

export function resolveCurrentOwnedIdentities(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): ProcessTreeOwnershipResolution {
  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  const childHasNotExited = !hasChildExited(child);
  // The root PID may enter a delayed-reclamation window before the exit callback reaches JavaScript.
  // Without a fixed root identity, or when the live identity no longer matches, never capture a fresh tree by bare PID.
  if (!childHasNotExited) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }

  if (knownRootIdentity) {
    const rootIdentityStillCurrent =
      filterCurrentProcessIdentities([knownRootIdentity], options).length === 1;
    if (!rootIdentityStillCurrent) {
      return {
        childStillOwned: false,
        currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
        knownIdentities: [...knownIdentities],
      };
    }
  }

  if (!knownRootIdentity && !allowRootDiscovery) {
    // If the force timer retries establishing identity from rootPid after the first query fails,
    // a reused PID could cause an unrelated process tree to be claimed as the runtime; fail closed for the rest of this cleanup.
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = captureLiveIdentities(child, options);
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  if (!knownRootIdentity && !freshRootIdentity) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }
  if (
    knownRootIdentity &&
    freshRootIdentity &&
    !isSameProcessIdentity(knownRootIdentity, freshRootIdentity)
  ) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  const mergedIdentities = mergeIdentities(
    knownIdentities,
    freshRootIdentity ? freshIdentities : [],
  );
  const currentIdentities = filterCurrentProcessIdentities(mergedIdentities, options);
  return {
    // The root may exit between the previous identity check and fresh capture; signal the root PID/PGID only if the final
    // revalidated set still contains the root. Never trust a stale boolean result.
    childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
    currentIdentities,
    knownIdentities: mergedIdentities,
  };
}

export async function resolveCurrentOwnedIdentitiesAsync(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): Promise<ProcessTreeOwnershipResolution> {
  if (process.platform !== "win32") {
    return resolveCurrentOwnedIdentities(child, knownIdentities, options, allowRootDiscovery);
  }

  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  if (hasChildExited(child)) {
    if (!knownIdentities.some((identity) => isPidAlive(identity.pid))) {
      return {
        childStillOwned: false,
        currentIdentities: [],
        knownIdentities: [...knownIdentities],
      };
    }
    return {
      childStillOwned: false,
      currentIdentities: await filterCurrentProcessIdentitiesAsync(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  if (knownRootIdentity) {
    const currentIdentities = await filterCurrentProcessIdentitiesAsync(knownIdentities, options);
    return {
      childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
      currentIdentities,
      knownIdentities: [...knownIdentities],
    };
  }
  if (!allowRootDiscovery) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = [
    ...((await captureProcessTreeSnapshotAsync(child, options))?.identities ?? []),
  ];
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  return {
    childStillOwned: Boolean(freshRootIdentity),
    currentIdentities: freshRootIdentity ? freshIdentities : [],
    knownIdentities: freshRootIdentity ? freshIdentities : [],
  };
}
