import { describe, expect, it } from "vitest";
import {
  EMPTY_DELETED_TASK_FACTS,
  isKnownDeletedTask,
  reconcileDeletedTaskFacts,
  type DeletedTaskFactRow,
  type DirectoryReadFacts,
} from "@/project-sidebar/deletedTaskFacts.js";

const REMOTE = "remote:ssh:dev";

const remoteDeleted: DeletedTaskFactRow = {
  taskId: "task-r",
  workspacePath: "/home/dev/app",
  workspaceIdentity: "remote:ssh:dev:app",
  hostId: REMOTE,
};

// A read in which the remote host is a directory member and answered with the given tombstones.
function readOnline(deletedTasks: DeletedTaskFactRow[]): DirectoryReadFacts {
  return { tree: { deletedTasks }, directory: { hosts: [{ id: REMOTE }] }, errors: new Map() };
}

// A read in which the remote host is a member but its tree read failed (offline).
function readRemoteOffline(): DirectoryReadFacts {
  return {
    tree: { deletedTasks: [] },
    directory: { hosts: [{ id: REMOTE }] },
    errors: new Map([[REMOTE, "host offline"]]),
  };
}

describe("deletion facts owned by the project directory", () => {
  it("keeps a deleted remote task known while its host is offline", () => {
    const online = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readOnline([remoteDeleted]),
    });
    const offline = reconcileDeletedTaskFacts({ previous: online, read: readRemoteOffline() });

    expect(isKnownDeletedTask(offline, remoteDeleted)).toBe(true);
  });

  it("does not invent deletion facts for a host that was never read (cold start while offline)", () => {
    const coldStart = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readRemoteOffline(),
    });

    expect(isKnownDeletedTask(coldStart, remoteDeleted)).toBe(false);
    expect(coldStart.byHost.has(REMOTE)).toBe(false);
  });

  it("replaces a readable host's set, so a restored task leaves the facts", () => {
    const deleted = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readOnline([remoteDeleted]),
    });
    const restored = reconcileDeletedTaskFacts({ previous: deleted, read: readOnline([]) });

    expect(isKnownDeletedTask(restored, remoteDeleted)).toBe(false);
  });

  it("drops a host's set only when it leaves directory membership", () => {
    const online = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readOnline([remoteDeleted]),
    });
    const left = reconcileDeletedTaskFacts({
      previous: online,
      read: { tree: { deletedTasks: [] }, directory: { hosts: [] }, errors: new Map() },
    });

    expect(isKnownDeletedTask(left, remoteDeleted)).toBe(false);
  });

  it("does not drop a known host when the read carries no membership information", () => {
    const online = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readOnline([remoteDeleted]),
    });
    const withoutDirectory = reconcileDeletedTaskFacts({
      previous: online,
      read: { tree: { deletedTasks: [remoteDeleted] } },
    });

    expect(isKnownDeletedTask(withoutDirectory, remoteDeleted)).toBe(true);
  });

  it("keys facts by full identity: the same taskId in another workspace is not deleted", () => {
    const facts = reconcileDeletedTaskFacts({
      previous: EMPTY_DELETED_TASK_FACTS,
      read: readOnline([remoteDeleted]),
    });

    expect(isKnownDeletedTask(facts, { taskId: "task-r", workspacePath: "/home/dev/app" })).toBe(
      false,
    );
    expect(
      isKnownDeletedTask(facts, {
        taskId: "task-r",
        workspacePath: "/home/dev/app",
        workspaceIdentity: "remote:ssh:dev:app",
      }),
    ).toBe(true);
  });
});
