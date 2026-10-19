// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorktreeCreationFailureModalDialog } from "@/v4/composer/WorktreeCreationFailureModal.js";

vi.mock("@/components/ui/dialog.js", () => {
  const Passthrough = ({ children }: { children?: unknown }) =>
    createElement("div", null, children as never);
  return {
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
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
