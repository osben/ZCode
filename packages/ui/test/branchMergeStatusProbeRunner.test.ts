import assert from "assert/strict";
import test from "node:test";
import type { GitBranchMergeStatus } from "@zcode/shared";
import { useBranchMergeStatusStore } from "../src/store/branchMergeStatusStore.js";
import {
  createBranchMergeStatusProber,
  type BranchMergeProbeStore,
  type BranchMergeStatusTarget,
} from "../src/lib/branchMergeStatusProbeRunner.js";

const MERGED: GitBranchMergeStatus = {
  state: "merged",
  baseRef: "origin/main",
  headRef: "feat/x",
  lastCommitAt: "2026-10-10T00:00:00Z",
};

function createStoreCapture(): BranchMergeProbeStore & {
  entries: Map<string, GitBranchMergeStatus>;
  dropped: string[];
} {
  const entries = new Map<string, GitBranchMergeStatus>();
  const dropped: string[] = [];
  return {
    entries,
    dropped,
    setBranchMergeStatus: (key, status) => {
      entries.set(key, status);
    },
    dropWorkspace: (key) => {
      entries.delete(key);
      dropped.push(key);
    },
  };
}

function createTarget(
  workspaceKey: string,
  getBranchMergeStatus: BranchMergeStatusTarget["gitService"]["getBranchMergeStatus"],
): BranchMergeStatusTarget {
  return {
    workspaceKey,
    workspacePath: `/${workspaceKey}`,
    gitService: { getBranchMergeStatus } as BranchMergeStatusTarget["gitService"],
  };
}

test("successful probe mirrors the status into the store", async () => {
  const store = createStoreCapture();
  const prober = createBranchMergeStatusProber(store);
  await prober.probe([createTarget("w", async () => MERGED)]);
  assert.equal(store.entries.get("w"), MERGED);
  assert.deepEqual(store.dropped, []);
});

test("failed probe drops the workspace entry so a stale Merged badge disappears", async () => {
  const store = createStoreCapture();
  store.entries.set("w", MERGED);
  const warnings: unknown[][] = [];
  const prober = createBranchMergeStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });

  await prober.probe([
    createTarget("w", async () => {
      throw new Error("method not found on old host");
    }),
  ]);
  assert.equal(store.entries.has("w"), false, "stale entry removed on failure");
  assert.deepEqual(store.dropped, ["w"]);

  // Повторная неудача предупреждает один раз на workspace.
  await prober.probe([
    createTarget("w", async () => {
      throw new Error("still down");
    }),
  ]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(store.dropped, ["w", "w"]);

  // Успех после сбоев сбрасывает warn-once.
  await prober.probe([createTarget("w", async () => MERGED)]);
  await prober.probe([
    createTarget("w", async () => {
      throw new Error("down again");
    }),
  ]);
  assert.equal(warnings.length, 2);
});

test("stale-write guard: only the newest probe per workspace writes", async () => {
  const store = createStoreCapture();
  const prober = createBranchMergeStatusProber(store);
  let releaseSlow: (status: GitBranchMergeStatus) => void = () => {};
  const slow = createTarget(
    "w",
    () =>
      new Promise<GitBranchMergeStatus>((resolve) => {
        releaseSlow = resolve;
      }),
  );
  const fast = createTarget("w", async () => MERGED);

  const slowProbe = prober.probe([slow]);
  await prober.probe([fast]);
  releaseSlow(MERGED);
  await slowProbe;

  assert.equal(store.entries.get("w"), MERGED, "fast probe wins");
  assert.deepEqual(store.dropped, []);
});

test("forget clears per-workspace bookkeeping", async () => {
  const store = createStoreCapture();
  const warnings: unknown[][] = [];
  const prober = createBranchMergeStatusProber(store, {
    warn: (...args) => {
      warnings.push(args);
    },
  });
  const failing = createTarget("w", async () => {
    throw new Error("nope");
  });
  await prober.probe([failing]);
  assert.equal(warnings.length, 1);

  // Workspace покинул сайдбар и вернулся — счётчик warn-once начинается заново.
  prober.forget("w");
  await prober.probe([failing]);
  assert.equal(warnings.length, 2);
});

test("requestRefresh bumps the mutation-signal version", () => {
  // In-app мутация (смена ветки/коммит) будит пробы через этот счётчик.
  const before = useBranchMergeStatusStore.getState().refreshVersion;
  useBranchMergeStatusStore.getState().requestRefresh();
  assert.equal(useBranchMergeStatusStore.getState().refreshVersion, before + 1);
});
