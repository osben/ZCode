import { taskRefKey, type TaskIdentityRef } from "@/lib/taskNavigationHistory.js";

/** Deleted-task row from `ProjectTree.deletedTasks`, which the directory read reports per host. */
export interface DeletedTaskFactRow extends TaskIdentityRef {
  hostId: string;
}

/**
 * Last-known deletion facts owned by the project directory.
 * `byHost` keeps each member host's tombstones; `keys` is the identity-keyed lookup derived from it.
 */
export interface DeletedTaskFacts {
  readonly byHost: ReadonlyMap<string, readonly TaskIdentityRef[]>;
  readonly keys: ReadonlySet<string>;
}

function createDeletedTaskFacts(
  byHost: ReadonlyMap<string, readonly TaskIdentityRef[]>,
): DeletedTaskFacts {
  const keys = new Set<string>();
  for (const rows of byHost.values()) {
    for (const row of rows) keys.add(taskRefKey(row));
  }
  return { byHost, keys };
}

export const EMPTY_DELETED_TASK_FACTS: DeletedTaskFacts = createDeletedTaskFacts(new Map());

/** Identity-keyed check; a task absent from the facts is unknown, not deleted. */
export function isKnownDeletedTask(facts: DeletedTaskFacts, task: TaskIdentityRef): boolean {
  return facts.keys.has(taskRefKey(task));
}

// Host id of the window's own tasks. Local tombstones carry hostId "local" because the repository reports
// `ownerHostId ?? "local"` (project-repository.ts readTree); this module and view.ts mergeProjectTrees rely on it.
export const LOCAL_TASK_HOST_ID = "local";

/**
 * The directory read facts the owner needs. `directory` and `errors` are optional: an absent membership
 * means no host is known to have left, and an absent error map means no host read failed.
 */
export interface DirectoryReadFacts {
  tree: { deletedTasks?: readonly DeletedTaskFactRow[] };
  directory?: { hosts: ReadonlyArray<{ id: string }> };
  errors?: ReadonlyMap<string, unknown>;
}

/**
 * Advances the facts from one accepted directory read.
 * - A member host whose read succeeded replaces its set, including with an empty set (restored tasks leave the facts).
 * - A member host whose read failed (offline or error) keeps its last-known set.
 * - A host that left directory membership is dropped.
 * - A host with no previous facts and no successful read stays unknown (no tombstones).
 */
export function reconcileDeletedTaskFacts(input: {
  previous: DeletedTaskFacts;
  read: DirectoryReadFacts;
}): DeletedTaskFacts {
  const { previous, read } = input;
  const memberHostIds = read.directory
    ? [LOCAL_TASK_HOST_ID, ...read.directory.hosts.map((host) => host.id)]
    : [LOCAL_TASK_HOST_ID, ...previous.byHost.keys()];
  const unreadHostIds = new Set(read.errors?.keys() ?? []);
  const deletedTasks = read.tree.deletedTasks ?? [];

  const byHost = new Map<string, readonly TaskIdentityRef[]>();
  for (const hostId of memberHostIds) {
    if (unreadHostIds.has(hostId)) {
      const retained = previous.byHost.get(hostId);
      if (retained) byHost.set(hostId, retained);
      continue;
    }
    byHost.set(
      hostId,
      deletedTasks
        .filter((row) => row.hostId === hostId)
        .map(({ taskId, workspacePath, workspaceIdentity }) => ({
          taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        })),
    );
  }
  return createDeletedTaskFacts(byHost);
}
