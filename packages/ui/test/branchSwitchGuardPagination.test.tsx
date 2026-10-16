// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useGlobalTaskList: vi.fn(),
  toast: vi.fn(),
  taskListResult: { items: [] as unknown[], loading: false, hasCurrentResult: true },
}));
const useGlobalTaskList = mocks.useGlobalTaskList;

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: (options: unknown) => {
    mocks.useGlobalTaskList(options);
    return mocks.taskListResult;
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

vi.mock("@/components/ui/alert-dialog.js", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "" } }),
}));

import { useBranchSwitchGuardShell } from "@/v4/composer/branchSwitchGuard.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.taskListResult = { items: [], loading: false, hasCurrentResult: true };
});

describe("branch switch guard task scope", () => {
  it("loads the complete active task list instead of the collapsed sidebar page", () => {
    renderHook(() =>
      useBranchSwitchGuardShell({
        workspaceTabs: [{ workspacePath: "/dev/alpha" }],
      }),
    );

    expect(useGlobalTaskList).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "active", expanded: true, collapsedLimit: 0 }),
    );
  });

  it("fails closed with retry guidance until the current task-list query succeeds", async () => {
    mocks.taskListResult = { items: [], loading: false, hasCurrentResult: false };
    let confirm!: ReturnType<typeof useBranchSwitchGuardShell>["confirm"];
    function Harness() {
      confirm = useBranchSwitchGuardShell({
        workspaceTabs: [{ workspacePath: "/dev/alpha" }],
      }).confirm;
      return null;
    }
    render(<Harness />);

    await expect(
      confirm({ workspaceKey: "/dev/alpha", targetBranchName: "feature/test", scope: "checkout" }),
    ).resolves.toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("branchSwitchGuard.listUnavailable");
  });

  it("serializes overlapping confirmations and settles each resolver once", async () => {
    mocks.taskListResult = {
      items: [
        {
          taskId: "running",
          workspacePath: "/dev/alpha",
          title: "Running task",
          activity: { phase: "running" },
        },
      ],
      loading: false,
      hasCurrentResult: true,
    };
    let confirm!: ReturnType<typeof useBranchSwitchGuardShell>["confirm"];
    function Harness() {
      const state = useBranchSwitchGuardShell({
        workspaceTabs: [{ workspacePath: "/dev/alpha" }],
      });
      confirm = state.confirm;
      return state.dialog;
    }
    render(<Harness />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirm({
        workspaceKey: "/dev/alpha",
        targetBranchName: "feature/one",
        scope: "checkout",
      });
      second = confirm({
        workspaceKey: "/dev/alpha",
        targetBranchName: "feature/two",
        scope: "checkout",
      });
    });

    expect(screen.getAllByText("branchSwitchGuard.confirm")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText("branchSwitchGuard.confirm"));
      await expect(first).resolves.toBe(true);
    });
    expect(screen.getAllByText("branchSwitchGuard.confirm")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText("common.cancel"));
      await expect(second).resolves.toBe(false);
    });
  });
});
