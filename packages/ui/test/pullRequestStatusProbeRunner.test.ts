import assert from "assert/strict";
import test from "node:test";
import type { SessionPullRequestsRequest, SessionPullRequestStatus } from "@zcode/shared";
import { usePullRequestStatusStore } from "../src/store/pullRequestStatusStore.js";
import {
  buildPullRequestTaskKey,
  selectPrimarySessionPullRequest,
  selectTaskPullRequestStatus,
} from "../src/store/pullRequestStatusStore.js";
import {
  createPullRequestStatusProber,
  forceTaskIdsForRequestedKeys,
  type PullRequestProbeStore,
  type PullRequestStatusTarget,
} from "../src/lib/pullRequestStatusProbeRunner.js";

const READY: SessionPullRequestStatus = {
  state: "ready",
  unavailableReason: null,
  source: "branch",
  pullRequests: [
    {
      number: 7,
      url: "https://github.com/osben/ZCode/pull/7",
      title: "Example",
      repository: "osben/ZCode",
      headRefName: "feat/x",
      stage: "open",
      checks: "passing",
      failingCheckCount: 0,
      totalCheckCount: 2,
      hasConflict: false,
      reviewDecision: null,
      additions: 3,
      deletions: 1,
      updatedAt: "2026-10-18T10:00:00Z",
      mergedAt: null,
    },
  ],
  primaryNumber: 7,
  fetchedAt: "2026-10-18T10:00:01Z",
  stale: false,
};

const EMPTY: SessionPullRequestStatus = {
  state: "ready",
  unavailableReason: null,
  source: "branch",
  pullRequests: [],
  primaryNumber: null,
  fetchedAt: "2026-10-18T10:00:01Z",
  stale: false,
};

function createStoreCapture(): PullRequestProbeStore & {
  entriesByWorkspace: Map<string, Record<string, SessionPullRequestStatus>>;
  dropped: string[];
} {
  const entriesByWorkspace = new Map<string, Record<string, SessionPullRequestStatus>>();
  const dropped: string[] = [];
  return {
    entriesByWorkspace,
    dropped,
    setWorkspacePullRequestStatuses: (workspaceKey, entries) => {
      entriesByWorkspace.set(workspaceKey, { ...entries });
    },
    dropWorkspaceTasks: (workspaceKey) => {
      entriesByWorkspace.delete(workspaceKey);
      dropped.push(workspaceKey);
    },
    markWorkspaceTasksStale: (workspaceKey, taskIds) => {
      const entries = entriesByWorkspace.get(workspaceKey);
      if (!entries) return;
      for (const taskId of taskIds) {
        const current = entries[taskId];
        if (current) entries[taskId] = { ...current, stale: true };
      }
    },
  };
}

function createTarget(
  workspaceKey: string,
  getSessionPullRequests: (
    request: SessionPullRequestsRequest,
  ) => Promise<Record<string, SessionPullRequestStatus>>,
  taskIds: string[] = ["t1"],
): PullRequestStatusTarget {
  return {
    workspaceKey,
    workspacePath: `/${workspaceKey}`,
    gitService: { getSessionPullRequests } as PullRequestStatusTarget["gitService"],
    tasks: taskIds.map((taskId) => ({
      input: { taskId, branchName: "feat/x", worktreePath: `/wt/${taskId}` },
      running: false,
    })),
  };
}

test("successful probe mirrors per-task entries into the store", async () => {
  const store = createStoreCapture();
  const prober = createPullRequestStatusProber(store);
  await prober.probe([createTarget("w", async () => ({ t1: READY }))]);
  assert.deepEqual(store.entriesByWorkspace.get("w"), { t1: READY });
  assert.deepEqual(store.dropped, []);
});

test("failed probe marks only its own task entries stale and warns once", async () => {
  const store = createStoreCapture();
  store.entriesByWorkspace.set("w", { t1: READY });
  const warnings: unknown[][] = [];
  const prober = createPullRequestStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });

  const failing = createTarget("w", async () => {
    throw new Error("method not found on old host");
  });
  await prober.probe([failing]);
  assert.deepEqual(
    store.entriesByWorkspace.get("w"),
    { t1: { ...READY, stale: true } },
    "last answer is kept and marked stale",
  );
  assert.deepEqual(store.dropped, [], "other drivers' entries are not dropped");

  await prober.probe([failing]);
  assert.equal(warnings.length, 1, "repeat failures warn once");

  await prober.probe([createTarget("w", async () => ({ t1: READY }))]);
  await prober.probe([failing]);
  assert.equal(warnings.length, 2, "success resets the warn-once latch");
});

test("non-object responses degrade like failures", async () => {
  const store = createStoreCapture();
  const warnings: unknown[][] = [];
  const prober = createPullRequestStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });
  // Old web stubs may answer undefined for unlisted methods.
  await prober.probe([
    createTarget("w", async () => undefined as unknown as Record<string, SessionPullRequestStatus>),
  ]);
  assert.equal(store.entriesByWorkspace.has("w"), false);
  assert.equal(warnings.length, 1);
});

test("stale-write guard: only the newest probe per workspace writes", async () => {
  const store = createStoreCapture();
  const prober = createPullRequestStatusProber(store);
  let releaseSlow: (status: Record<string, SessionPullRequestStatus>) => void = () => {};
  const slow = createTarget("w", () => {
    return new Promise<Record<string, SessionPullRequestStatus>>((resolve) => {
      releaseSlow = resolve;
    });
  });
  const fast = createTarget("w", async () => ({ t1: EMPTY }));

  const slowProbe = prober.probe([slow]);
  await prober.probe([fast]);
  releaseSlow({ t1: READY });
  await slowProbe;

  assert.deepEqual(store.entriesByWorkspace.get("w"), { t1: EMPTY }, "fast probe wins");
  assert.deepEqual(store.dropped, []);
});

test("force probes pass forceTaskIds for the target's tasks", async () => {
  const store = createStoreCapture();
  const prober = createPullRequestStatusProber(store);
  const requests: SessionPullRequestsRequest[] = [];
  await prober.probe(
    [
      createTarget("w", async (request) => {
        requests.push(request);
        return { t1: READY };
      }),
    ],
    { force: true },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.forceTaskIds, ["t1"], "turn-end refresh bypasses the TTL");
});

test("forget clears per-workspace bookkeeping", async () => {
  const store = createStoreCapture();
  const warnings: unknown[][] = [];
  const prober = createPullRequestStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });
  const failing = createTarget("w", async () => {
    throw new Error("nope");
  });
  await prober.probe([failing]);
  assert.equal(warnings.length, 1);

  prober.forget("w");
  await prober.probe([failing]);
  assert.equal(warnings.length, 2);
});

test("store merges probe answers so visible-row probes keep other drivers' entries", () => {
  const store = usePullRequestStatusStore.getState();
  // The sidebar probed all tasks; the Session manager re-probes only visible t1.
  store.setWorkspacePullRequestStatuses("w", { t1: READY, t2: EMPTY });
  store.setWorkspacePullRequestStatuses("w", { t1: READY });
  const state = usePullRequestStatusStore.getState();
  assert.deepEqual(
    Object.keys(state.statusByTaskKey).sort(),
    [buildPullRequestTaskKey("w", "t1"), buildPullRequestTaskKey("w", "t2")],
    "t2 survives a probe that did not include it",
  );

  store.dropWorkspaceTasks("w");
  assert.deepEqual(usePullRequestStatusStore.getState().statusByTaskKey, {});
});

test("selectors expose the task entry and the primary pull request", () => {
  const store = usePullRequestStatusStore.getState();
  store.setWorkspacePullRequestStatuses("w", { t1: READY });
  const state = usePullRequestStatusStore.getState();
  assert.equal(selectTaskPullRequestStatus(state, "w", "t1"), READY);
  assert.equal(selectTaskPullRequestStatus(state, "w", "missing"), undefined);
  assert.equal(selectPrimarySessionPullRequest(READY)?.number, 7);
  assert.equal(selectPrimarySessionPullRequest(EMPTY), null);
  assert.equal(selectPrimarySessionPullRequest(null), null);
  usePullRequestStatusStore.getState().dropWorkspaceTasks("w");
});

test("requestRefresh bumps the mutation-signal version", () => {
  const before = usePullRequestStatusStore.getState().refreshVersion;
  usePullRequestStatusStore.getState().requestRefresh();
  assert.equal(usePullRequestStatusStore.getState().refreshVersion, before + 1);
});

test("warning carries a generic message and the error class, never the workspace key or error text", async () => {
  const store = createStoreCapture();
  const warnings: unknown[][] = [];
  const prober = createPullRequestStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });
  await prober.probe([
    createTarget("/private/ws-key", async () => {
      throw new TypeError("cannot read /secret/remote https://example.test/owner/repo");
    }),
  ]);
  assert.deepEqual(warnings, [
    ["session pull request status unavailable", { errorName: "TypeError" }],
  ]);
  assert.equal(JSON.stringify(warnings).includes("secret"), false);
  assert.equal(JSON.stringify(warnings).includes("ws-key"), false);
});

test("explicit refresh selects only the requested tasks of the given targets", () => {
  const targets = [
    createTarget("w", async () => ({}), ["t1", "t2"]),
    createTarget("v", async () => ({}), ["t1"]),
  ];
  assert.deepEqual(forceTaskIdsForRequestedKeys(targets, [buildPullRequestTaskKey("w", "t2")]), [
    "t2",
  ]);
  assert.deepEqual(
    forceTaskIdsForRequestedKeys(targets, [
      buildPullRequestTaskKey("w", "t1"),
      buildPullRequestTaskKey("v", "t1"),
      buildPullRequestTaskKey("v", "missing"),
    ]),
    ["t1"],
    "ids are deduplicated across workspaces and unknown keys select nothing",
  );
  assert.deepEqual(forceTaskIdsForRequestedKeys(targets, []), []);
});
