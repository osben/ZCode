// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskTreeCounts } from "@zcode/services";
import { SessionManagerDeleteDialog } from "@/session-manager/SessionManagerDeleteDialog.js";
import type { SessionManagerRow } from "@/session-manager/sessionManagerModel.js";

// specs/session-deletion-cascade.md §2-§3: child-aware Hide copy and the opt-in erase step.

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${Object.values(values).join("|")}` : id,
      formatPlural: ({ id }: { id: string }, count: number) => `${id}:${count}`,
    },
  }),
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function makeRow(taskId: string): SessionManagerRow {
  return {
    task: { taskId, title: taskId, workspacePath: "/project" },
    taskKey: taskId,
    workspaceKey: "/project",
    archived: false,
    pinned: false,
    running: false,
    offline: false,
  } as unknown as SessionManagerRow;
}

const counts = (patch: Partial<ZCodeTaskTreeCounts> = {}): ZCodeTaskTreeCounts => ({
  total: 1,
  sideChats: 0,
  subagents: 0,
  workflowSessions: 0,
  workflowRuns: 0,
  running: 0,
  ...patch,
});

function mount(options: {
  counts: ZCodeTaskTreeCounts | null;
  canErase?: boolean;
  rows?: SessionManagerRow[];
}) {
  const onConfirm = vi.fn();
  render(
    createElement(SessionManagerDeleteDialog, {
      selectedRows: options.rows ?? [makeRow("a")],
      loadTreeCounts: async () => options.counts,
      canEraseRow: () => options.canErase ?? true,
      onCancel: vi.fn(),
      onConfirm,
    }),
  );
  return { onConfirm };
}

describe("SessionManagerDeleteDialog", () => {
  it("lists the children that are hidden together with the sessions", async () => {
    mount({ counts: counts({ sideChats: 2, subagents: 3, total: 6 }) });
    expect(
      await screen.findByText(
        "sessionManager.delete.includes:taskList.childSideChatsCount:2, taskList.childSubagentsCount:3",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("sessionManager.delete.includesGeneric")).toBeNull();
  });

  it("shows no child line for sessions without children", async () => {
    mount({ counts: counts() });
    await screen.findByText("sessionManager.erase.checkbox");
    expect(screen.queryByText(/sessionManager\.delete\.includes/)).toBeNull();
  });

  it("falls back to the generic sentence and hides erase when counts are unavailable", async () => {
    mount({ counts: null });
    expect(await screen.findByText("sessionManager.delete.includesGeneric")).toBeTruthy();
    expect(screen.queryByText("sessionManager.erase.checkbox")).toBeNull();
  });

  it("hides erase for workspaces that cannot erase", async () => {
    mount({ counts: counts({ sideChats: 1 }), canErase: false });
    await screen.findByText(/sessionManager\.delete\.includes:/);
    expect(screen.queryByText("sessionManager.erase.checkbox")).toBeNull();
  });

  it("confirms Hide without erase by default", async () => {
    const { onConfirm } = mount({ counts: counts({ subagents: 1, total: 2 }) });
    await screen.findByText("sessionManager.erase.checkbox");
    fireEvent.click(screen.getByRole("button", { name: "sessionManager.delete.confirm:1" }));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ taskKey: "a" })], {
      erase: false,
    });
  });

  it("switches the confirm to Erase with the exact total once the checkbox is on", async () => {
    const { onConfirm } = mount({ counts: counts({ subagents: 1, total: 2 }) });
    fireEvent.click(await screen.findByRole("checkbox", { name: "sessionManager.erase.checkbox" }));
    expect(screen.getByText("sessionManager.erase.warning:2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "sessionManager.erase.confirm:1" }));
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ taskKey: "a" })], {
      erase: true,
    });
  });

  it("warns about running sessions and keeps erase unavailable", async () => {
    const { onConfirm } = mount({ counts: counts({ running: 2, total: 3 }) });
    expect(await screen.findByText("sessionManager.delete.running:2")).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", { name: "sessionManager.erase.checkbox" });
    expect(
      checkbox.hasAttribute("disabled") || checkbox.getAttribute("data-disabled") !== null,
    ).toBe(true);
    expect(screen.getByText("sessionManager.erase.blocked:2")).toBeTruthy();
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.queryByText("sessionManager.erase.warning:3")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "sessionManager.delete.confirm:1" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.anything(), { erase: false });
  });
});
