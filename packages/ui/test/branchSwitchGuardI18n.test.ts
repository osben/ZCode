// @vitest-environment jsdom
// Regression test for BUG-GWT-012 (docs/testing/git-worktree-qa/bugs/BUG-GWT-012.md):
// the branch-switch guard dialog description must render the localized plural count
// ("1 running task"), not the raw ICU plural template from the message catalog.
// The real ZCodeIntlProvider + real en-US catalog are used so the test exercises the
// same formatMessage path as the app; only the task-list hook, toast, and dialog
// primitives are mocked.
import { createElement } from "react";
import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taskListResult: { items: [] as unknown[], loading: false, hasCurrentResult: true },
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => mocks.taskListResult,
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

vi.mock("@/components/ui/alert-dialog.js", async () => {
  const { createElement } = await import("react");
  type BoxProps = { children?: ReactNode } & Record<string, unknown>;
  // Drop radix-only props (asChild/onOpenChange) so they are not forwarded to the DOM.
  const box = ({ children, asChild: _asChild, onOpenChange: _onOpenChange, ...rest }: BoxProps) =>
    createElement("div", rest, children);
  const button = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    createElement("button", { onClick }, children);
  return {
    AlertDialog: box,
    AlertDialogAction: button,
    AlertDialogCancel: button,
    AlertDialogContent: box,
    AlertDialogDescription: box,
    AlertDialogFooter: box,
    AlertDialogHeader: box,
    AlertDialogTitle: box,
  };
});

import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useBranchSwitchGuardShell } from "@/v4/composer/branchSwitchGuard.js";

afterEach(() => {
  cleanup();
  mocks.taskListResult = { items: [], loading: false, hasCurrentResult: true };
});

describe("branch switch guard dialog i18n", () => {
  // See docs/testing/git-worktree-qa/bugs/BUG-GWT-012.md: formatMessage cannot expand inline ICU
  // plurals, so the description is assembled from a formatMessage prefix plus the formatPlural
  // taskCount family; this test guards that the localized count renders, not a raw template.
  it("BUG-GWT-012: guard dialog renders the localized plural instead of the raw ICU template", () => {
    mocks.taskListResult = {
      items: [
        {
          taskId: "running-task",
          workspacePath: "/dev/alpha",
          title: "Reply with OK only",
          activity: { phase: "running" },
        },
      ],
      loading: false,
      hasCurrentResult: true,
    };

    type ConfirmFn = ReturnType<typeof useBranchSwitchGuardShell>["confirm"];
    function GuardDialogHarness({ onConfirm }: { onConfirm: (confirm: ConfirmFn) => void }) {
      const shell = useBranchSwitchGuardShell({
        workspaceTabs: [{ workspacePath: "/dev/alpha" }],
      });
      onConfirm(shell.confirm);
      return shell.dialog;
    }

    let confirm!: ConfirmFn;
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(GuardDialogHarness, { onConfirm: (next) => (confirm = next) }),
      ),
    );

    act(() => {
      void confirm({ workspaceKey: "/dev/alpha", targetBranchName: "release", scope: "checkout" });
    });

    const dialog = document.querySelector('[data-branch-switch-guard-dialog="true"]');
    expect(dialog).not.toBeNull();
    const text = dialog?.textContent ?? "";
    // The {branch} placeholder is substituted in the current implementation.
    expect(text).toContain("release");
    // The count must be rendered as localized text, not leaked as a raw ICU plural template.
    expect(text).not.toContain("{count, plural");
    expect(text).toContain("1 running task");
  });
});
