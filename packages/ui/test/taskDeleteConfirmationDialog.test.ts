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
      loadWorktreePreview:
        options.loadWorktreePreview ??
        (async () => (options.worktrees === undefined ? [] : options.worktrees)),
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
    // The plain Delete label is reserved for a known-clean preview, never shown while loading.
    expect(screen.queryByRole("button", { name: "taskDelete.confirm:1" })).toBeNull();
    const loading = screen.getByRole("button", { name: "taskDelete.deleteAnyway:1" });
    expect(loading.hasAttribute("disabled")).toBe(true);
    resolveWorktrees([]);
    const button = await screen.findByRole("button", { name: "taskDelete.confirm:1" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
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

  it("treats an explicit single pinned row as opted in", async () => {
    const { onConfirm } = mount({ rows: [row("p", { pinned: true })], counts: counts() });
    const confirm = await screen.findByRole("button", { name: "taskDelete.confirm:1" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("taskDelete.unsupported")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith([row("p", { pinned: true })]);
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

  it("requires an explicit acknowledgement before Delete anyway when worktree status is unknown", async () => {
    const { onConfirm } = mount({
      rows: [row("a", { executionWorktree: { path: "/repo/.worktrees/a" } })],
      counts: counts(),
      worktrees: null,
    });
    expect(await screen.findByText("taskDelete.worktreeUnknown")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "taskDelete.confirm:1" })).toBeNull();
    const confirm = screen.getByRole("button", {
      name: "taskDelete.deleteAnyway:1",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "taskDelete.worktreeUnknownAcknowledge" }),
    );
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith([
      row("a", { executionWorktree: { path: "/repo/.worktrees/a" } }),
    ]);
  });

  it("treats a rejected worktree preview as unknown, not clean", async () => {
    const { onConfirm } = mount({
      counts: counts(),
      loadWorktreePreview: async () => {
        throw new Error("git unavailable");
      },
    });
    const confirm = (await screen.findByRole("button", {
      name: "taskDelete.deleteAnyway:1",
    })) as HTMLButtonElement;
    expect(
      screen.getByRole("checkbox", { name: "taskDelete.worktreeUnknownAcknowledge" }),
    ).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clears the unknown-status acknowledgement when the candidate set changes", async () => {
    const loadWorktreePreview = vi.fn(async () => null);
    mount({
      rows: [row("normal"), row("pinned", { pinned: true })],
      counts: counts(),
      loadWorktreePreview,
    });
    const acknowledge = await screen.findByRole("checkbox", {
      name: "taskDelete.worktreeUnknownAcknowledge",
    });
    fireEvent.click(acknowledge);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "taskDelete.deleteAnyway:1" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "taskDelete.includePinned:1" }));
    await waitFor(() => expect(loadWorktreePreview).toHaveBeenCalledTimes(2));
    const confirm = (await screen.findByRole("button", {
      name: "taskDelete.deleteAnyway:2",
    })) as HTMLButtonElement;
    const reloaded = await screen.findByRole("checkbox", {
      name: "taskDelete.worktreeUnknownAcknowledge",
    });
    expect(reloaded.getAttribute("aria-checked")).toBe("false");
    expect(confirm.disabled).toBe(true);
  });

  it("links the unknown-status warning to the acknowledgement and the confirm control", async () => {
    mount({ counts: counts(), worktrees: null });
    const warning = await screen.findByText(/^taskDelete\.worktreeUnknown$/);
    expect(warning.id).toBeTruthy();
    const acknowledge = screen.getByRole("checkbox", {
      name: "taskDelete.worktreeUnknownAcknowledge",
    });
    const confirm = screen.getByRole("button", { name: "taskDelete.deleteAnyway:1" });
    expect(acknowledge.getAttribute("aria-describedby")?.split(" ")).toContain(warning.id);
    expect(confirm.getAttribute("aria-describedby")?.split(" ")).toContain(warning.id);
  });

  it("notes that ignored files are deleted whenever a worktree is involved", async () => {
    mount({ counts: counts(), worktrees: [{ path: "/repo/.worktrees/a", files: [] }] });
    expect(await screen.findByText("taskDelete.worktreeIgnoredNotice")).toBeTruthy();
    cleanup();
    mount({ counts: counts(), worktrees: null });
    expect(await screen.findByText("taskDelete.worktreeIgnoredNotice")).toBeTruthy();
    cleanup();
    mount({ counts: counts(), worktrees: [] });
    await screen.findByRole("button", { name: "taskDelete.confirm:1" });
    expect(screen.queryByText("taskDelete.worktreeIgnoredNotice")).toBeNull();
  });

  it("keeps known-clean worktrees on the plain Delete flow without an acknowledgement", async () => {
    const { onConfirm } = mount({
      rows: [row("a", { executionWorktree: { path: "/repo/.worktrees/a" } })],
      counts: counts(),
      worktrees: [{ path: "/repo/.worktrees/a", files: [] }],
    });
    const confirm = (await screen.findByRole("button", {
      name: "taskDelete.confirm:1",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("taskDelete.worktreeUnknown")).toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps known-dirty worktrees on one-click Delete anyway without an acknowledgement", async () => {
    const { onConfirm } = mount({
      counts: counts(),
      worktrees: [{ path: "/repo/.worktrees/a", files: [{ path: "src/a.ts", status: "M" }] }],
    });
    const confirm = (await screen.findByRole("button", {
      name: "taskDelete.deleteAnyway:1",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps an acknowledged unknown status blocked by other guards", async () => {
    mount({ counts: counts({ running: 1 }), worktrees: null });
    const acknowledge = await screen.findByRole("checkbox", {
      name: "taskDelete.worktreeUnknownAcknowledge",
    });
    fireEvent.click(acknowledge);
    await waitFor(() => expect(acknowledge.getAttribute("aria-checked")).toBe("true"));
    expect(
      (screen.getByRole("button", { name: "taskDelete.deleteAnyway:1" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
