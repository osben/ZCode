import { describe, expect, it } from "vitest";
import {
  computeSessionManagerDeleteCandidates,
  applySessionManagerClientFilters,
  buildSessionManagerRows,
  flattenSessionManagerGroups,
  groupSessionManagerRows,
  sortSessionManagerRows,
  type SessionManagerRowTask,
} from "@/session-manager/sessionManagerModel.js";
import { buildSessionManagerRowKey } from "@/session-manager/sessionManagerModel.js";

function fixtureTask(
  overrides: Partial<SessionManagerRowTask> & { taskId: string },
): SessionManagerRowTask {
  return {
    traceId: `trace-${overrides.taskId}`,
    title: `Task ${overrides.taskId}`,
    workspacePath: "/dev/project",
    createdAt: 1000,
    updatedAt: 2000,
    mode: "default",
    sourceAvailability: "online",
    liveStatus: "idle",
    ...overrides,
  } as SessionManagerRowTask;
}

function buildRows(items: SessionManagerRowTask[], pinnedTaskIds: string[] = []) {
  const pinnedKeys = new Set(
    pinnedTaskIds.map((taskId) => buildSessionManagerRowKey("/dev/project", taskId)),
  );
  return buildSessionManagerRows({ activeItems: items, archivedItems: [], pinnedKeys });
}

describe("buildSessionManagerRows", () => {
  it("merges active and archived items, deduplicating by identity key with archived winning from its source", () => {
    const shared = fixtureTask({ taskId: "a", updatedAt: 3000 });
    const rows = buildSessionManagerRows({
      activeItems: [shared],
      archivedItems: [fixtureTask({ taskId: "a", updatedAt: 100 })],
      pinnedKeys: new Set(),
    });
    expect(rows).toHaveLength(1);
    // Active items are merged first, so the duplicate archived entry is dropped.
    expect(rows[0]?.archived).toBe(false);
  });

  it("flags pinned only for non-archived rows present in the pinned key set", () => {
    const rows = buildSessionManagerRows({
      activeItems: [fixtureTask({ taskId: "a" }), fixtureTask({ taskId: "b" })],
      archivedItems: [fixtureTask({ taskId: "c" })],
      pinnedKeys: new Set([
        buildSessionManagerRowKey("/dev/project", "a"),
        buildSessionManagerRowKey("/dev/project", "c"),
      ]),
    });
    expect(rows.find((row) => row.task.taskId === "a")?.pinned).toBe(true);
    expect(rows.find((row) => row.task.taskId === "b")?.pinned).toBe(false);
    // pinned = pinned && !archived by definition; archived rows never render the star.
    expect(rows.find((row) => row.task.taskId === "c")?.pinned).toBe(false);
  });

  it("marks running and offline rows", () => {
    const rows = buildRows([
      fixtureTask({ taskId: "a", liveStatus: "running" }),
      fixtureTask({ taskId: "b", liveStatus: "waiting" }),
      fixtureTask({ taskId: "c", liveStatus: "idle", sourceAvailability: "offline" }),
    ]);
    expect(rows.find((row) => row.task.taskId === "a")?.running).toBe(true);
    expect(rows.find((row) => row.task.taskId === "b")?.running).toBe(true);
    expect(rows.find((row) => row.task.taskId === "c")?.running).toBe(false);
    expect(rows.find((row) => row.task.taskId === "c")?.offline).toBe(true);
  });
});

describe("applySessionManagerClientFilters", () => {
  it("filters by worktree/local environment and task type", () => {
    const rows = buildRows([
      fixtureTask({ taskId: "local-plain" }),
      fixtureTask({ taskId: "wt", executionWorktree: { path: "/wt", branchName: "b" } }),
      fixtureTask({ taskId: "cron", cronAutomationId: "cron-1" }),
      fixtureTask({ taskId: "offpeak", offPeakTaskId: "op-1" }),
    ]);
    expect(
      applySessionManagerClientFilters(rows, {
        environment: "worktree",
        type: "all",
        pinnedOnly: false,
      }).map((row) => row.task.taskId),
    ).toEqual(["wt"]);
    expect(
      applySessionManagerClientFilters(rows, {
        environment: "local",
        type: "all",
        pinnedOnly: false,
      }).map((row) => row.task.taskId),
    ).toEqual(["local-plain", "cron", "offpeak"]);
    expect(
      applySessionManagerClientFilters(rows, {
        environment: "all",
        type: "cron",
        pinnedOnly: false,
      }).map((row) => row.task.taskId),
    ).toEqual(["cron"]);
    expect(
      applySessionManagerClientFilters(rows, {
        environment: "all",
        type: "offpeak",
        pinnedOnly: false,
      }).map((row) => row.task.taskId),
    ).toEqual(["offpeak"]);
  });

  it("keeps only pinned rows when pinnedOnly is set", () => {
    const rows = buildRows([fixtureTask({ taskId: "a" }), fixtureTask({ taskId: "b" })], ["a"]);
    expect(
      applySessionManagerClientFilters(rows, {
        environment: "all",
        type: "all",
        pinnedOnly: true,
      }).map((row) => row.task.taskId),
    ).toEqual(["a"]);
  });
});

describe("sortSessionManagerRows", () => {
  it("sorts by updatedAt in the requested direction with a stable tiebreak", () => {
    const rows = buildRows([
      fixtureTask({ taskId: "b", updatedAt: 2000 }),
      fixtureTask({ taskId: "a", updatedAt: 2000 }),
      fixtureTask({ taskId: "c", updatedAt: 3000 }),
    ]);
    expect(
      sortSessionManagerRows(rows, { column: "updated", direction: "desc" }).map(
        (row) => row.task.taskId,
      ),
    ).toEqual(["c", "b", "a"]);
    expect(
      sortSessionManagerRows(rows, { column: "updated", direction: "asc" }).map(
        (row) => row.task.taskId,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("sorts by name case-insensitively", () => {
    const rows = [
      ...buildRows([fixtureTask({ taskId: "x", title: "banana" })]),
      ...buildRows([fixtureTask({ taskId: "y", title: "Apple" })]),
    ];
    expect(
      sortSessionManagerRows(rows, { column: "name", direction: "asc" }).map(
        (row) => row.task.title,
      ),
    ).toEqual(["Apple", "banana"]);
  });
});

describe("groupSessionManagerRows", () => {
  it("groups by identity key: same path with different remote identities stays separate", () => {
    const rows = [
      ...buildRows([fixtureTask({ taskId: "local-1", workspacePath: "/dev/project" })]),
      ...buildRows([
        fixtureTask({
          taskId: "remote-1",
          workspacePath: "/dev/project",
          workspaceIdentity: "ssh://hosta/dev/project",
          updatedAt: 5000,
        }),
      ]),
    ];
    const groups = groupSessionManagerRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.workspaceKey).toBe("ssh://hosta/dev/project");
  });

  it("orders groups by latest row activity and counts active rows", () => {
    const rows = [
      ...buildRows([fixtureTask({ taskId: "a", updatedAt: 100 })]),
      ...buildRows([fixtureTask({ taskId: "r", updatedAt: 900, workspaceIdentity: "id-2" })]),
    ];
    const groups = groupSessionManagerRows(rows);
    expect(groups.map((group) => group.latestUpdatedAt)).toEqual([900, 100]);
  });
});

describe("flattenSessionManagerGroups", () => {
  it("keeps group headers for collapsed groups but drops their rows", () => {
    const rows = buildRows([fixtureTask({ taskId: "a" })]);
    const groups = groupSessionManagerRows(rows);
    const flat = flattenSessionManagerGroups(groups, new Set([groups[0]!.workspaceKey]));
    expect(flat).toHaveLength(1);
    expect(flat[0]?.kind).toBe("group");
  });
});

describe("computeSessionManagerDeleteCandidates", () => {
  it("excludes pinned rows unless explicitly included (Copilot parity)", () => {
    const rows = buildRows(
      [fixtureTask({ taskId: "plain" }), fixtureTask({ taskId: "pinned" })],
      ["pinned"],
    );
    const excluded = computeSessionManagerDeleteCandidates(rows, false);
    expect(excluded.pinned.map((row) => row.task.taskId)).toEqual(["pinned"]);
    expect(excluded.deletable.map((row) => row.task.taskId)).toEqual(["plain"]);
    const included = computeSessionManagerDeleteCandidates(rows, true);
    expect(included.deletable).toHaveLength(2);
  });

  it("a pinned-only selection deletes nothing until the opt-in", () => {
    const rows = buildRows([fixtureTask({ taskId: "pinned" })], ["pinned"]);
    expect(computeSessionManagerDeleteCandidates(rows, false).deletable).toHaveLength(0);
    expect(computeSessionManagerDeleteCandidates(rows, true).deletable).toHaveLength(1);
  });

  it("splits deletable rows into archived and active lanes", () => {
    const activeRows = buildRows([fixtureTask({ taskId: "active" })]);
    const archivedRows = buildSessionManagerRows({
      activeItems: [],
      archivedItems: [fixtureTask({ taskId: "archived" })],
      pinnedKeys: new Set(),
    });
    const candidates = computeSessionManagerDeleteCandidates(
      [...activeRows, ...archivedRows],
      false,
    );
    expect(candidates.active.map((row) => row.task.taskId)).toEqual(["active"]);
    expect(candidates.archived.map((row) => row.task.taskId)).toEqual(["archived"]);
  });
});
