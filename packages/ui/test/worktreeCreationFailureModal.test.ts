// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  WorktreeCreationFailureModalDialog,
  WorktreeFailureModalHost,
} from "@/v4/composer/WorktreeCreationFailureModal.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";

const modalHost = vi.hoisted(() => ({
  state: {
    activeWorkspacePath: "/repo",
    activeWorkspaceIdentity: null,
    activeTabId: "__settings__",
    tabs: [{ id: "__settings__", kind: "settings" }],
  },
  activateTabByPath: vi.fn(),
}));
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/dialog.js", () => {
  const Passthrough = ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never);
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: toastSpy }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: TabStoreState) => unknown) =>
    selector(modalHost.state as unknown as TabStoreState),
  useTabStoreApi: () => ({
    getState: () => ({ activateTabByPath: modalHost.activateTabByPath }),
  }),
}));

afterEach(() => {
  cleanup();
  useWorktreeFailureReturnStore.getState().closeFailureModal("/repo");
  toastSpy.mockReset();
});

function renderDialog(props: {
  issueCode: string | null;
  savedNotRestored?: boolean;
  onRetry?: () => void;
}) {
  const onRetry = props.onRetry ?? vi.fn();
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorktreeCreationFailureModalDialog, {
        message: "Could not create the worktree",
        rawDetail: null,
        issueCode: props.issueCode,
        ...(props.savedNotRestored ? { savedNotRestored: true } : {}),
        onRetry,
        onChangeDestination: vi.fn(),
        onDismiss: vi.fn(),
      }),
    ),
  );
  return { onRetry };
}

const RETRY_LABEL = "Retry";

describe("WorktreeCreationFailureModalDialog Retry", () => {
  it("offers Retry for a transient failure when the draft was restored", () => {
    const { onRetry } = renderDialog({ issueCode: "git-unavailable" });
    fireEvent.click(screen.getByRole("button", { name: RETRY_LABEL }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides Retry when the saved message stayed on the recovery card (savedNotRestored)", () => {
    const { onRetry } = renderDialog({ issueCode: "git-unavailable", savedNotRestored: true });
    expect(screen.queryByRole("button", { name: RETRY_LABEL })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByText(/Unsent message saved/)).toBeTruthy();
  });

  it("keeps Change branch/folder for configuration failures regardless of savedNotRestored", () => {
    renderDialog({ issueCode: "target-branch-not-found", savedNotRestored: true });
    expect(screen.queryByRole("button", { name: RETRY_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: "Change branch/folder" })).toBeTruthy();
  });
});

describe("WorktreeFailureModalHost", () => {
  it("defers the failure modal while workspace Settings is active", () => {
    useWorktreeFailureReturnStore.getState().openFailureModal("/repo", {
      workspacePath: "/repo",
      sessionId: "failed-session",
      submissionId: "failed-submission",
      issueCode: "git-unavailable",
      message: "Could not create the worktree",
      rawDetail: null,
      savedAt: Date.now(),
    });

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorktreeFailureModalHost),
      ),
    );

    expect(screen.queryByText("Could not create the worktree")).toBeNull();
    expect(toastSpy).toHaveBeenCalledOnce();
  });

  it("announces a Retry failure for the same session again while the user is away", () => {
    const failure = {
      workspacePath: "/repo",
      sessionId: "prepared-session",
      issueCode: "git-unavailable",
      message: "Could not create the worktree",
      rawDetail: null,
      savedAt: Date.now(),
    };
    useWorktreeFailureReturnStore
      .getState()
      .openFailureModal("/repo", { ...failure, attemptId: "attempt-1" });

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorktreeFailureModalHost),
      ),
    );
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Same announced attempt re-written (for example by a draft-state update): no second toast.
    act(() => {
      useWorktreeFailureReturnStore.getState().markFailureSavedNotRestored("/repo");
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);

    // Retry creates a new failed attempt for the same prepared session: announced again.
    act(() => {
      useWorktreeFailureReturnStore
        .getState()
        .openFailureModal("/repo", { ...failure, attemptId: "attempt-2" });
    });
    expect(toastSpy).toHaveBeenCalledTimes(2);
    expect(toastSpy.mock.calls[0]?.[1]?.dedupeKey).toBe(
      "worktree-failure:prepared-session:attempt-1",
    );
    expect(toastSpy.mock.calls[1]?.[1]?.dedupeKey).toBe(
      "worktree-failure:prepared-session:attempt-2",
    );
  });
});
