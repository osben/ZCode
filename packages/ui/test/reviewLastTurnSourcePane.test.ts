// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";

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
    fileChanges: vi.fn(),
    providerReady: true,
    providerProps: [] as Array<Record<string, unknown>>,
    gitStates: [] as GitPaneRepositoryState[],
    context: null as unknown,
  };
});
harness.context = {
  layer: {
    acquire: (sessionId: string) => ({
      sessionId,
      store: harness.store,
      startedAt: 0,
      release: () => {},
    }),
  },
  fileChanges: (params: unknown) => harness.fileChanges(params),
};

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => harness.context,
  // Mirrors the real provider contract: children render only while the connection is ready.
  V4PaneConversationProvider: (props: { children: ReactNode } & Record<string, unknown>) => {
    harness.providerProps.push(props);
    return harness.providerReady ? props.children : null;
  },
}));
vi.mock("@/GitPane.js", () => ({
  GitPane: (props: { gitState: GitPaneRepositoryState }) => {
    harness.gitStates.push(props.gitState);
    return null;
  },
}));

import { GitPaneWithLastTurn } from "@/review-last-turn/index.js";

function header(rowId: number) {
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
    fileChanges: { files: 1, additions: 4, deletions: 0 },
  };
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
        patches: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
      },
    ],
  };
}

const gitState = {
  workspaceKey: "/repo",
  workspacePath: "/repo",
  sourceOptions: [{ id: "last-turn", count: 0, readonly: true, disabled: false }],
  datasets: {
    unstaged: { id: "unstaged", readonly: false, sections: [] },
    staged: { id: "staged", readonly: false, sections: [] },
    branch: { id: "branch", readonly: true, sections: [] },
    "last-turn": { id: "last-turn", readonly: true, sections: [] },
  },
} as unknown as GitPaneRepositoryState;

function pane(sessionId: string) {
  const noop = () => {};
  return createElement(GitPaneWithLastTurn, {
    sessionId,
    conversationScope: { workspacePath: "/repo" },
    gitState,
    workspacePath: "/repo",
    selectedSourceId: "last-turn",
    fileChangeFindActiveIndex: 0,
    fileChangeFindNavigationRequestId: 0,
    fileChangeFindQuery: "",
    onFileChangeFindMatchCountChange: noop,
    onSelectSource: noop,
    onClose: noop,
    onRefresh: noop,
  });
}

function lastTurnPaths(state: GitPaneRepositoryState | undefined): string[] {
  return (state?.datasets["last-turn"].sections ?? []).flatMap((section) =>
    section.changes.map((change) => change.path),
  );
}

describe("GitPaneWithLastTurn (ISSUE-056)", () => {
  beforeEach(() => {
    harness.fileChanges.mockReset();
    harness.providerReady = true;
    harness.providerProps = [];
    harness.gitStates = [];
    harness.setSnapshot({ revision: 1, logEpoch: "e1", rows: { window: [header(1)] } });
  });
  afterEach(() => cleanup());

  it("never hands the previous task's files to GitPane after a task switch", async () => {
    harness.fileChanges.mockResolvedValue(result("/repo/a.js"));
    const view = render(pane("task-a"));
    await waitFor(() => expect(lastTurnPaths(harness.gitStates.at(-1))).toEqual(["/repo/a.js"]));

    harness.fileChanges.mockResolvedValue(result("/repo/b.js"));
    const firstAfterSwitch = harness.gitStates.length;
    view.rerender(pane("task-b"));
    await waitFor(() => expect(lastTurnPaths(harness.gitStates.at(-1))).toEqual(["/repo/b.js"]));
    const afterSwitch = harness.gitStates.slice(firstAfterSwitch);
    expect(afterSwitch.some((state) => lastTurnPaths(state).includes("/repo/a.js"))).toBe(false);
  });

  it("clears the Last turn files when the conversation connection becomes unavailable", async () => {
    harness.fileChanges.mockResolvedValue(result("/repo/a.js"));
    const view = render(pane("task-a"));
    await waitFor(() => expect(lastTurnPaths(harness.gitStates.at(-1))).toEqual(["/repo/a.js"]));
    // The side pane must not opt into the provider's disconnected-session retention.
    expect(harness.providerProps.at(-1)).not.toHaveProperty("sessionId");

    harness.providerReady = false;
    act(() => view.rerender(pane("task-a")));
    expect(lastTurnPaths(harness.gitStates.at(-1))).toEqual([]);
  });
});
