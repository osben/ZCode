// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskTreeCounts } from "@zcode/services";
import { TaskDeleteConfirmationDialog } from "@/task-deletion/TaskDeleteConfirmationDialog.js";
import type { TaskDeleteDialogRow } from "@/task-deletion/taskDeletionTypes.js";

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

function row(taskId: string, patch: Partial<TaskDeleteDialogRow> = {}): TaskDeleteDialogRow {
  return {
    id: taskId,
    title: taskId,
    archived: false,
    pinned: false,
    ...patch,
  };
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
  rows?: TaskDeleteDialogRow[];
  counts: ZCodeTaskTreeCounts | null;
  loadTreeCounts?: (rows: readonly TaskDeleteDialogRow[]) => Promise<ZCodeTaskTreeCounts | null>;
  worktrees?:
    | { path: string; branchName?: string; files: { path: string; status: string }[] }[]
    | null;
  loadWorktreePreview?: (
    rows: readonly TaskDeleteDialogRow[],
  ) => Promise<
    { path: string; branchName?: string; files: { path: string; status: string }[] }[] | null
  >;
  supported?: boolean;
}) {
  const onConfirm = vi.fn();
  render(
    createElement(TaskDeleteConfirmationDialog, {
      rows: options.rows ?? [row("a")],
      supported: options.supported ?? true,
      loadTreeCounts: options.loadTreeCounts ?? (async () => options.counts),
      loadWorktreePreview: options.loadWorktreePreview ?? (async () => options.worktrees ?? []),
      onCancel: vi.fn(),
      onConfirm,
    }),
  );
  return { onConfirm };
}

describe("TaskDeleteConfirmationDialog", () => {
  it("shows no descendant line while counts load and omits zero categories", async () => {
    let resolveCounts!: (value: ZCodeTaskTreeCounts) => void;
    mount({
      counts: counts(),
      loadTreeCounts: () => new Promise((resolve) => (resolveCounts = resolve)),
    });
    expect(screen.queryByText(/taskDelete\.includes/)).toBeNull();
    resolveCounts(counts());
    await waitFor(() => expect(screen.queryByText(/taskDelete\.includes/)).toBeNull());
  });

  it("keeps confirmation disabled until asynchronous previews settle", async () => {
    let resolveWorktrees!: (value: []) => void;
    mount({
      counts: counts(),
      loadWorktreePreview: () => new Promise((resolve) => (resolveWorktrees = resolve)),
    });
    const button = screen.getByRole("button", { name: "taskDelete.confirm:1" });
    expect(button.hasAttribute("disabled") || button.getAttribute("data-disabled") !== null).toBe(
      true,
    );
    resolveWorktrees([]);
    await waitFor(() =>
      expect(button.hasAttribute("disabled") || button.getAttribute("data-disabled") !== null).toBe(
        false,
      ),
    );
  });

  it("shows a generic descendant warning when counts are unavailable", async () => {
    mount({ counts: null });
    expect(await screen.findByText("taskDelete.includesGeneric")).toBeTruthy();
  });

  it("keeps pinned rows out until opted in and refreshes the preview candidates", async () => {
    const loadTreeCounts = vi.fn(async (rows: readonly TaskDeleteDialogRow[]) =>
      counts({ total: rows.length }),
    );
    const { onConfirm } = mount({
      rows: [row("normal"), row("pinned", { pinned: true })],
      counts: counts(),
      loadTreeCounts,
    });
    await waitFor(() => expect(loadTreeCounts).toHaveBeenCalledTimes(1));
    expect(loadTreeCounts).toHaveBeenLastCalledWith([row("normal")]);
    fireEvent.click(screen.getByRole("checkbox", { name: "taskDelete.includePinned:1" }));
    await waitFor(() =>
      expect(loadTreeCounts).toHaveBeenLastCalledWith([
        row("normal"),
        row("pinned", { pinned: true }),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "taskDelete.confirm:2" }));
    expect(onConfirm).toHaveBeenCalledWith([row("normal"), row("pinned", { pinned: true })]);
  });

  it("warns about dirty worktree paths and labels the destructive action Delete anyway", async () => {
    const worktrees = [
      {
        path: "/repo/.worktrees/task-a",
        branchName: "task-a",
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "notes.txt", status: "??" },
        ],
      },
    ];
    mount({ counts: counts(), worktrees });
    expect(await screen.findByText(/taskDelete\.dirtyWarning/)).toBeTruthy();
    expect(screen.getByText("src/a.ts").closest("li")?.textContent).toContain("M");
    expect(screen.getByText("notes.txt").closest("li")?.textContent).toContain("??");
    expect(screen.getByRole("button", { name: "taskDelete.deleteAnyway:1" })).toBeTruthy();
  });

  it("blocks a known running tree before confirmation", async () => {
    const { onConfirm } = mount({ counts: counts({ running: 1 }) });
    expect(await screen.findByText("taskDelete.running:1")).toBeTruthy();
    const button = screen.getByRole("button", { name: "taskDelete.confirm:1" });
    expect(button.hasAttribute("disabled") || button.getAttribute("data-disabled") !== null).toBe(
      true,
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("explains unsupported permanent deletion and disables confirmation", async () => {
    mount({ counts: counts(), supported: false });
    expect(await screen.findByText("taskDelete.unsupported")).toBeTruthy();
    const button = screen.getByRole("button", { name: "taskDelete.confirm:1" });
    expect(button.hasAttribute("disabled") || button.getAttribute("data-disabled") !== null).toBe(
      true,
    );
  });
});
