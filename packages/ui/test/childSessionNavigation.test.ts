import { expect, it, vi } from "vitest";
import { routeChildSessionSelection } from "@/project-sidebar/child-session-navigation.js";

const parent = { taskId: "parent", workspacePath: "/repo", workspaceIdentity: "remote:s:/repo" };

it("routes a subagent to the right pane under its parent (spec §8.2)", () => {
  const openSubagentSession = vi.fn();
  const selectInMainPane = vi.fn();
  routeChildSessionSelection({
    parent,
    sessionId: "child",
    options: { readOnly: true, selectionSideChat: false },
    title: "Child",
    openSubagentSession,
    selectInMainPane,
  });
  expect(openSubagentSession).toHaveBeenCalledWith({
    workspacePath: "/repo",
    workspaceIdentity: "remote:s:/repo",
    parentSessionId: "parent",
    childSessionId: "child",
    title: "Child",
  });
  expect(selectInMainPane).not.toHaveBeenCalled();
});

it("keeps side chats, the overflow row, and shells without a side pane in the main pane", () => {
  for (const [sessionId, options, open] of [
    ["side", { readOnly: false, selectionSideChat: true }, vi.fn()],
    ["parent", { readOnly: false, selectionSideChat: false }, vi.fn()],
    ["child", { readOnly: true, selectionSideChat: false }, undefined],
  ] as const) {
    const selectInMainPane = vi.fn();
    routeChildSessionSelection({
      parent,
      sessionId,
      options,
      openSubagentSession: open,
      selectInMainPane,
    });
    expect(selectInMainPane).toHaveBeenCalledTimes(1);
    if (open) expect(open).not.toHaveBeenCalled();
  }
});
