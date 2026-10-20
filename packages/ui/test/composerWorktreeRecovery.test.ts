// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerWorktreeRecovery } from "@/v4/composer/ComposerWorktreeRecovery.js";
import {
  getV4WorktreeRecoveryScope,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
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
