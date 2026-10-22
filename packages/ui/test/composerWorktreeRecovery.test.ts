// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerWorktreeRecovery } from "@/v4/composer/ComposerWorktreeRecovery.js";
import {
  getV4WorktreeRecoveryScope,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  setV4FirstSubmissionActive,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("explicit worktree recovery", () => {
  it("keeps multiple failed submissions independently recoverable", () => {
    persistV4ComposerDraft("/repo", undefined, getV4WorktreeRecoveryScope("prepared", "first"), {
      text: "first failed message",
    });
    persistV4ComposerDraft("/repo", undefined, getV4WorktreeRecoveryScope("prepared", "second"), {
      text: "second failed message",
    });
    const restore = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ComposerWorktreeRecovery, {
          workspacePath: "/repo",
          scopeId: "prepared",
          editorEmpty: true,
          attachments: [],
          onRestore: restore,
          onRetry: vi.fn(),
          onDiscardAttachments: async () => {},
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
    expect(restore.mock.calls[0]?.[0].text).toBe("first failed message");
    expect(
      readV4WorktreeRecoveryDrafts("/repo", undefined, "prepared").map((item) => item.draft.text),
    ).toEqual(["second failed message"]);
  });

  it("leaves a newer editor unchanged and restores only after it is empty", () => {
    const scope = getV4WorktreeRecoveryScope("prepared");
    persistV4ComposerDraft("/repo", undefined, scope, { text: "submitted A" });
    const onRestore = vi.fn();
    const view = (editorEmpty: boolean) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ComposerWorktreeRecovery, {
          workspacePath: "/repo",
          scopeId: "prepared",
          editorEmpty,
          attachments: [],
          onRestore,
          onRetry: vi.fn(),
          onDiscardAttachments: async () => {},
        }),
      );
    const { rerender } = render(view(false));
    const button = screen.getByRole("button", {
      name: "Restore",
      exact: true,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRestore).not.toHaveBeenCalled();
    expect(readV4ComposerDraft("/repo", undefined, scope)?.text).toBe("submitted A");
    rerender(view(true));
    fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ text: "submitted A" }));
    expect(readV4ComposerDraft("/repo", undefined, scope)).toBeNull();
  });

  it("requires reattachment or explicit removal of files lost at process reload", () => {
    persistV4ComposerDraft("/repo", undefined, getV4WorktreeRecoveryScope("prepared"), {
      text: "with file",
      recoveryAttachments: [{ id: "lost", filename: "source.txt" }],
    });
    const restore = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ComposerWorktreeRecovery, {
          workspacePath: "/repo",
          scopeId: "prepared",
          editorEmpty: true,
          attachments: [],
          onRestore: restore,
          onRetry: vi.fn(),
          onDiscardAttachments: async () => {},
        }),
      ),
    );
    expect(
      (screen.getByRole("button", { name: "Restore", exact: true }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove missing files" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ text: "with file", recoveryAttachments: [] }),
    );
  });

  it("re-hydrates a clipboard-text attachment from its persisted path instead of demanding reattach", async () => {
    const scope = getV4WorktreeRecoveryScope("prepared");
    persistV4ComposerDraft("/repo", undefined, scope, {
      text: "long paste message",
      recoveryAttachments: [
        {
          id: "paste-1",
          filename: "pasted-text.txt",
          localPath: "/tmp/paste-attachments/2026-10-19/pasted-text.txt",
          mimeType: "text/plain",
          sizeBytes: 20480,
          sourceKind: "clipboard-text",
        },
      ],
    });
    const restore = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ComposerWorktreeRecovery, {
          workspacePath: "/repo",
          scopeId: "prepared",
          editorEmpty: true,
          attachments: [],
          onRestore: restore,
          onRetry: vi.fn(),
          onDiscardAttachments: async () => {},
        }),
      ),
    );
    // No reattach notice: the temp file's path metadata re-hydrates the in-memory item.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Restore", exact: true }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/Reattach the listed missing files/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "long paste message",
        recoveryAttachments: [
          expect.objectContaining({
            id: "paste-1",
            localPath: "/tmp/paste-attachments/2026-10-19/pasted-text.txt",
          }),
        ],
      }),
    );
  });
});

// specs/first-submission-instant-ux.md, Retry surface (IUX07/IUX09).
describe("failed first-submission retry card", () => {
  const scope = getV4WorktreeRecoveryScope("reserved-1", "sub-1");
  function seed(firstSubmission: Partial<NonNullable<V4ComposerDraft["firstSubmission"]>> = {}) {
    persistV4ComposerDraft("/repo", undefined, scope, {
      text: "frozen first message",
      firstSubmission: {
        submissionId: "sub-1",
        ownerKey: "__draft__",
        status: "failed",
        reservation: { sessionId: "reserved-1", commandId: "reserve-cmd" },
        ...firstSubmission,
      },
    });
  }
  function card(
    props: {
      editorEmpty?: boolean;
      scopeId?: string;
      retryBlockedReason?: string | null;
      onRetry?: () => void;
    } = {},
  ) {
    const onRetry = vi.fn(props.onRetry);
    const onRestore = vi.fn();
    const onRemove = vi.fn();
    const element = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ComposerWorktreeRecovery, {
          workspacePath: "/repo",
          scopeId: props.scopeId ?? "reserved-1",
          editorEmpty: props.editorEmpty ?? true,
          attachments: [],
          retryBlockedReason: props.retryBlockedReason ?? null,
          onRestore,
          onRetry,
          onRemove,
          onDiscardAttachments: async () => {},
        }),
      );
    const view = render(element());
    return { onRetry, onRestore, onRemove, rerender: () => view.rerender(element()) };
  }
  const removeButton = () => screen.queryByRole("button", { name: "Remove", exact: true });
  const retryButton = () => screen.queryByRole("button", { name: "Retry", exact: true });

  afterEach(() => setV4FirstSubmissionActive("/repo", undefined, "sub-1", false));

  it("offers Retry for a settled failed record without repeating the message text", () => {
    seed();
    card();
    expect(retryButton()).not.toBeNull();
    expect(screen.queryByText("frozen first message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore", exact: true })).toBeNull();
  });

  it("stays hidden while the submission is active and appears once it settles", () => {
    seed();
    setV4FirstSubmissionActive("/repo", undefined, "sub-1", true);
    card();
    expect(screen.queryByTestId("composer-worktree-recovery")).toBeNull();
    act(() => setV4FirstSubmissionActive("/repo", undefined, "sub-1", false));
    expect(retryButton()).not.toBeNull();
  });

  it.each(["sending", "unknown"] as const)(
    "never offers a resend for a %s record, only Remove (unresolved sendText command, FSL rule 4)",
    (status) => {
      seed({ status, commandId: "send-cmd" });
      const { onRemove } = card();
      expect(retryButton()).toBeNull();
      fireEvent.click(removeButton()!);
      expect(onRemove).toHaveBeenCalledWith(
        expect.objectContaining({ text: "frozen first message" }),
        scope,
      );
    },
  );

  it("never promises an unsent message once a sendText command existed", () => {
    seed({ status: "failed", commandId: "send-cmd" });
    card();
    expect(screen.getByText("Message saved; delivery not confirmed")).toBeTruthy();
    expect(screen.queryByText("Unsent message saved")).toBeNull();
  });

  it("offers explicit continue for an inactive preparing record after restart (IUX09)", () => {
    seed({ status: "preparing" });
    card();
    expect(retryButton()).not.toBeNull();
  });

  it("hands the record and its scope to the composer once, keeping the record in place", () => {
    seed();
    // The composer's retry freeze marks the submission active, which hides the card: there is
    // no "already clicked" lock that a no-op submit could leave behind.
    const { onRetry } = card({
      onRetry: () => setV4FirstSubmissionActive("/repo", undefined, "sub-1", true),
    });
    fireEvent.click(retryButton()!);
    expect(retryButton()).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "frozen first message",
        firstSubmission: expect.objectContaining({ submissionId: "sub-1" }),
      }),
      scope,
    );
    expect(readV4ComposerDraft("/repo", undefined, scope)?.firstSubmission?.submissionId).toBe(
      "sub-1",
    );
  });

  it("disables Retry with the concrete blocked reason tied through aria-describedby", () => {
    seed();
    const { onRetry } = card({ retryBlockedReason: "The session isn’t ready yet." });
    const button = retryButton() as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = screen.getByText("The session isn’t ready yet.");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("disables Retry and says why while another draft occupies the editor", () => {
    seed();
    const { onRetry } = card({ editorEmpty: false });
    expect((retryButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Send or clear the current draft before retrying.")).toBeTruthy();
    fireEvent.click(retryButton()!);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not offer Dismiss for a reserved record (it would strand the prepared session)", () => {
    seed();
    card();
    expect(screen.queryByRole("button", { name: "Dismiss saved message" })).toBeNull();
  });

  it("offers Remove instead of Dismiss for an unbound draft record", () => {
    const draftScope = getV4WorktreeRecoveryScope("__draft__", "sub-1");
    persistV4ComposerDraft("/repo", undefined, draftScope, {
      text: "never reserved",
      firstSubmission: { submissionId: "sub-1", ownerKey: "__draft__", status: "failed" },
    });
    card({ scopeId: "__draft__" });
    expect(screen.queryByRole("button", { name: "Dismiss saved message" })).toBeNull();
    expect(removeButton()).not.toBeNull();
    expect(retryButton()).not.toBeNull();
  });
});
