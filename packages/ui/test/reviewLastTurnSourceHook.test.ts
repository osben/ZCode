// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: { snapshot: unknown } = { snapshot: null };
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
  };
  return {
    store,
    setSnapshot(snapshot: unknown) {
      state = { snapshot };
      for (const listener of listeners) listener();
    },
    acquire: vi.fn((sessionId: string) => ({ sessionId, store, startedAt: 0, release: vi.fn() })),
    fileChanges: vi.fn(),
    context: null as unknown,
  };
});
// The real context value is memoized; a fresh layer per render would re-acquire forever.
harness.context = {
  layer: { acquire: (sessionId: string) => harness.acquire(sessionId) },
  fileChanges: (params: unknown) => harness.fileChanges(params),
};

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => harness.context,
}));

import { useLastTurnGitDataset } from "@/review-last-turn/index.js";

function header(rowId: number, files: number, additions = 4) {
  return {
    kind: "turnHeader",
    rowId,
    turnId: `turn-${rowId}`,
    entityId: `entity-${rowId}`,
    createdAt: "2026-10-23T16:00:00.000Z",
    createdAtSeq: rowId,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: "2026-10-23T16:00:00.000Z",
    ...(files > 0 ? { fileChanges: { files, additions, deletions: 0 } } : {}),
  };
}

function snapshot(revision: number, rows: unknown[]) {
  return { revision, logEpoch: "epoch-1", rows: { window: rows } };
}

function result(path: string): V4ConversationFileChangesResult {
  return {
    files: 1,
    additions: 4,
    deletions: 0,
    items: [
      {
        path,
        additions: 4,
        deletions: 0,
        writeCount: 1,
        toolNames: ["Edit"],
        patches: [
          { oldStart: 3, oldLines: 0, newStart: 4, newLines: 4, lines: ["+a", "+b", "+c", "+d"] },
        ],
      },
    ],
  };
}

const baseOptions = { sessionId: "task-1", workspacePath: "/repo", workspaceKey: "/repo" };

describe("useLastTurnGitDataset (ISSUE-056)", () => {
  beforeEach(() => {
    harness.acquire.mockClear();
    harness.fileChanges.mockReset();
    harness.setSnapshot(null);
  });
  afterEach(() => cleanup());

  it("loads the latest changed turn's files when the Last turn source is selected", async () => {
    harness.setSnapshot(snapshot(7, [header(1, 1), header(4, 0)]));
    harness.fileChanges.mockResolvedValue(result("/repo/src/math.js"));

    const { result: hook } = renderHook(() =>
      useLastTurnGitDataset({ ...baseOptions, enabled: true }),
    );

    await waitFor(() => expect(hook.current?.dataset.sections).toHaveLength(1));
    expect(harness.acquire).toHaveBeenCalledWith("task-1");
    expect(harness.fileChanges).toHaveBeenCalledWith({
      sessionId: "task-1",
      target: { rowId: 1, entityId: "entity-1" },
      baseRevision: 7,
      baseLogEpoch: "epoch-1",
    });
    expect(hook.current?.count).toBe(1);
    expect(hook.current?.dataset.sections[0]?.changes[0]?.workspaceRelativePath).toBe(
      "src/math.js",
    );
  });

  it("does not fetch while another source is selected and counts from the header", () => {
    harness.setSnapshot(snapshot(3, [header(1, 2)]));
    const { result: hook } = renderHook(() =>
      useLastTurnGitDataset({ ...baseOptions, enabled: false }),
    );
    expect(harness.fileChanges).not.toHaveBeenCalled();
    expect(hook.current?.count).toBe(2);
    expect(hook.current?.dataset.sections).toEqual([]);
  });

  it("returns null without a turn that changed files", () => {
    harness.setSnapshot(snapshot(3, [header(1, 0)]));
    const { result: hook } = renderHook(() =>
      useLastTurnGitDataset({ ...baseOptions, enabled: true }),
    );
    expect(hook.current).toBeNull();
    expect(harness.fileChanges).not.toHaveBeenCalled();
  });

  it("ignores new revisions with the same aggregate and drops a stale response", async () => {
    harness.setSnapshot(snapshot(1, [header(1, 1)]));
    let resolveFirst: (value: V4ConversationFileChangesResult) => void = () => {};
    harness.fileChanges.mockImplementationOnce(
      () => new Promise<V4ConversationFileChangesResult>((resolve) => (resolveFirst = resolve)),
    );
    harness.fileChanges.mockResolvedValueOnce(result("/repo/src/second.js"));

    const { result: hook } = renderHook(() =>
      useLastTurnGitDataset({ ...baseOptions, enabled: true }),
    );
    const beforeRevision = hook.current;
    act(() => harness.setSnapshot(snapshot(2, [header(1, 1)])));
    expect(harness.fileChanges).toHaveBeenCalledTimes(1);
    // Same request key: GitPane must get the same object and not re-render.
    expect(hook.current).toBe(beforeRevision);

    act(() => harness.setSnapshot(snapshot(3, [header(1, 1), header(5, 1, 2)])));
    await waitFor(() =>
      expect(hook.current?.dataset.sections[0]?.changes[0]?.path).toBe("/repo/src/second.js"),
    );
    expect(harness.fileChanges).toHaveBeenCalledTimes(2);

    await act(async () => resolveFirst(result("/repo/src/first.js")));
    expect(hook.current?.dataset.sections[0]?.changes[0]?.path).toBe("/repo/src/second.js");
  });
});
