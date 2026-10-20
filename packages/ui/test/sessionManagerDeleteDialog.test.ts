// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskTreeCounts } from "@zcode/services";
import { SessionManagerDeleteDialog } from "@/session-manager/SessionManagerDeleteDialog.js";
import type { SessionManagerRow } from "@/session-manager/sessionManagerModel.js";

// Permanent deletion shares the dialog; pinned inclusion remains explicit.

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
      loadCapability: async () => options.canErase ?? true,
      loadWorktreePreview: async () => [],
      onCancel: vi.fn(),
      onConfirm,
    }),
  );
  return { onConfirm };
}

describe("SessionManagerDeleteDialog", () => {
  it("shows exact descendants and confirms permanent deletion without an erase checkbox", async () => {
    const { onConfirm } = mount({ counts: counts({ sideChats: 2, subagents: 3, total: 6 }) });
    expect(
      await screen.findByText(
        "taskDelete.includes:taskList.childSideChatsCount:2, taskList.childSubagentsCount:3",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const button = screen.getByRole("button", { name: "taskDelete.confirm:1" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ taskKey: "a" })]);
  });

  it("omits zero child categories", async () => {
    mount({ counts: counts() });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "taskDelete.confirm:1" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByText(/taskDelete\.includes/)).toBeNull();
  });

  it("shows a generic descendant warning when counts fail", async () => {
    mount({ counts: null });
    expect(await screen.findByText("taskDelete.includesGeneric")).toBeTruthy();
  });

  it("disables unsupported deletion", async () => {
    const { onConfirm } = mount({ counts: counts(), canErase: false });
    expect(await screen.findByText("taskDelete.unsupported")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "taskDelete.confirm:1" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks running trees instead of offering a hide-only action", async () => {
    const { onConfirm } = mount({ counts: counts({ running: 2 }) });
    expect(await screen.findByText("taskDelete.running:2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "taskDelete.confirm:1" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps pinned sessions excluded until the user opts in", async () => {
    const pinned = { ...makeRow("pinned"), pinned: true };
    const { onConfirm } = mount({ counts: counts(), rows: [makeRow("a"), pinned] });
    const checkbox = await screen.findByRole("checkbox", { name: "taskDelete.includePinned:1" });
    fireEvent.click(checkbox);
    const button = await screen.findByRole("button", { name: "taskDelete.confirm:2" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ taskKey: "a" }),
      expect.objectContaining({ taskKey: "pinned" }),
    ]);
  });
});
