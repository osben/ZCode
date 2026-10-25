// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  saveEditor: vi.fn(),
  restoreDefault: vi.fn(),
  resetAllCustomized: vi.fn(),
  reloadEditor: vi.fn(),
  reload: vi.fn(),
  openInFileManager: vi.fn(),
  lastTarget: null as { workspacePath: string | null; workspaceIdentity?: string } | null,
  diskChanged: false,
  // The latest listing for cli-prefix; tests move it to simulate an external write.
  cliRevision: "rev-cli" as string | null | undefined,
  cliText: "The saved prompt" as string | null,
  // Revision a conflicting save reported; undefined when no conflict is active.
  conflictRevision: undefined as string | null | undefined,
  // Re-lists the mocked sections, as the hook's refreshInPlace does after a conflict.
  relist: null as (() => void) | null,
}));

vi.mock("@/hooks/useSystemPromptOverrides.js", async () => {
  const React = await import("react");
  return {
    useSystemPromptOverrides(target: { workspacePath: string | null; workspaceIdentity?: string }) {
      mocks.lastTarget = target;
      const [, relistRender] = React.useReducer((count: number) => count + 1, 0);
      mocks.relist = relistRender;
      // Rebuilt on every render, like a fresh listing from the hook.
      const sections = [
        {
          key: "cli-prefix",
          defaultContent: "The default prompt",
          overrideContent: mocks.cliText,
          filePath: "/remote/.zcode/system-prompt/cli-prefix.md",
          isOverridden: true,
          revision: mocks.cliRevision,
        },
        {
          key: "harness",
          defaultContent: "Harness default text",
          overrideContent: null,
          filePath: "/remote/.zcode/system-prompt/harness.md",
          isOverridden: false,
          revision: null,
        },
      ];
      const [editor, setEditor] = React.useState<{
        key: "cli-prefix" | "harness";
        baseline: string;
        draft: string;
        saving: boolean;
        baseRevision: string | null;
      } | null>(null);
      const [hostKey, setHostKey] = React.useState(target.workspaceIdentity ?? "local");
      React.useEffect(() => {
        const nextHostKey = target.workspaceIdentity ?? "local";
        if (hostKey === nextHostKey) return;
        setHostKey(nextHostKey);
        setEditor(null);
      }, [hostKey, target.workspaceIdentity]);
      const openEditor = (key: "cli-prefix" | "harness", effectiveContent: string) => {
        const section = sections.find((candidate) => candidate.key === key);
        setEditor({
          key,
          baseline: effectiveContent,
          draft: effectiveContent,
          saving: false,
          baseRevision: section?.revision ?? null,
        });
      };
      const setDraft = (draft: string) =>
        setEditor((current) => (current ? { ...current, draft } : current));
      const editorDirty = editor !== null && editor.draft !== editor.baseline;
      const editorDiskChanged = mocks.diskChanged && editor !== null;
      return {
        hostKey: `${target.workspaceIdentity ? "remote" : "local"}:${target.workspaceIdentity ?? "local"}`,
        isRemote: Boolean(target.workspaceIdentity),
        status: "ready",
        sections,
        editor:
          editor && mocks.conflictRevision !== undefined
            ? { ...editor, conflictRevision: mocks.conflictRevision }
            : editor,
        editorDirty,
        editorDiskChanged,
        canSaveEditor: editorDirty && !editorDiskChanged,
        reload: mocks.reload,
        openEditor,
        closeEditor: () => setEditor(null),
        setDraft,
        saveEditor: mocks.saveEditor,
        getOverridesDirectory: async () => "/remote/.zcode/system-prompt",
        reloadEditor: (effectiveContent: string) => {
          mocks.reloadEditor(effectiveContent);
          setEditor((current) =>
            current ? { ...current, baseline: effectiveContent, draft: effectiveContent } : current,
          );
        },
        restoreDefault: mocks.restoreDefault,
        resetAllCustomized: mocks.resetAllCustomized,
      };
    },
  };
});
vi.mock("@/hooks/useOutputStyles.js", () => ({
  useOutputStyles: () => ({
    status: "ready",
    activeStyleId: "default",
    styles: [{ id: "default", content: "", enabled: true }],
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openInFileManager: mocks.openInFileManager }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>) =>
        values ? `${descriptor.id} ${JSON.stringify(values)}` : descriptor.id,
    },
  }),
}));
vi.mock("@/store/confirmDialogStore.js", () => ({
  useConfirmDialogStore: {
    getState: () => ({ requestConfirmation: mocks.requestConfirmation }),
  },
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { SystemPromptSection } from "../src/settings/SystemPromptSection.js";

const targetA = { workspacePath: "/remote/a", workspaceIdentity: "ssh:a" };
const targetB = { workspacePath: "/remote/b", workspaceIdentity: "ssh:b" };

function renderSection(target = targetA, onDirtyChange = vi.fn()) {
  return render(
    createElement(SystemPromptSection, {
      isDesktop: true,
      activeTarget: target,
      onDirtyChange,
    }),
  );
}

beforeEach(() => {
  mocks.requestConfirmation.mockReset();
  mocks.saveEditor.mockReset();
  mocks.restoreDefault.mockReset();
  mocks.resetAllCustomized.mockReset();
  mocks.reloadEditor.mockReset();
  mocks.openInFileManager.mockReset();
  mocks.openInFileManager.mockResolvedValue({ success: true });
  mocks.requestConfirmation.mockResolvedValue(false);
  mocks.diskChanged = false;
  mocks.cliRevision = "rev-cli";
  mocks.cliText = "The saved prompt";
  mocks.conflictRevision = undefined;
  mocks.reload.mockReset();
});

afterEach(() => cleanup());

describe("SystemPromptSection", () => {
  it("shows the badge, size, path and effective preview for each row", () => {
    renderSection();
    const cliRow = screen.getByTestId("settings-system-prompt-row-cli-prefix");
    expect(within(cliRow).getByTestId("settings-system-prompt-customized-cli-prefix")).toBeTruthy();
    expect(
      within(cliRow).getByTestId("settings-system-prompt-size-cli-prefix").textContent,
    ).toContain("settings.systemPrompt.sizeLine");
    expect(within(cliRow).getByTestId("settings-system-prompt-path-cli-prefix").textContent).toBe(
      "/remote/.zcode/system-prompt/cli-prefix.md",
    );
    expect(within(cliRow).getByText("The saved prompt")).toBeTruthy();

    const harnessRow = screen.getByTestId("settings-system-prompt-row-harness");
    expect(within(harnessRow).getByText("settings.systemPrompt.defaultBadge")).toBeTruthy();
    expect(within(harnessRow).queryByTestId("settings-system-prompt-restore-harness")).toBeNull();
  });

  it("opens the editor inline under its own row and hides that row's preview", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));

    const row = screen.getByTestId("settings-system-prompt-row-cli-prefix");
    const editor = within(row).getByTestId("settings-system-prompt-editor-cli-prefix");
    expect((editor as HTMLTextAreaElement).value).toBe("The saved prompt");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(within(row).queryByText("The saved prompt", { selector: "pre" })).toBeNull();
    expect(screen.queryByTestId("settings-system-prompt-edit-cli-prefix")).toBeNull();
  });

  it("shows the diff vs saved and saves with Ctrl/Cmd+S; Escape cancels a clean draft", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    const editor = screen.getByTestId("settings-system-prompt-editor-cli-prefix");
    fireEvent.change(editor, { target: { value: "The edited prompt" } });
    expect(screen.getByTestId("settings-system-prompt-diff-cli-prefix")).toBeTruthy();

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(mocks.saveEditor).toHaveBeenCalledTimes(1);

    fireEvent.change(editor, { target: { value: "The saved prompt" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByTestId("settings-system-prompt-editor-cli-prefix")).toBeNull();
  });

  it("asks before discarding a dirty draft on Escape", async () => {
    mocks.requestConfirmation.mockResolvedValue(false);
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    const editor = screen.getByTestId("settings-system-prompt-editor-cli-prefix");
    fireEvent.change(editor, { target: { value: "unsaved" } });
    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => expect(mocks.requestConfirmation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("settings-system-prompt-editor-cli-prefix")).toBeTruthy();
  });

  it("explains why Edit and Restore are disabled while another draft is dirty", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: "unsaved" },
    });

    expect(screen.getByText(/settings\.systemPrompt\.dirtyNote/)).toBeTruthy();
    expect(screen.queryByTestId("settings-system-prompt-edit-harness")).not.toBeNull();
    expect(
      (screen.getByTestId("settings-system-prompt-edit-harness") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("settings-system-prompt-reset-all") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("settings-system-prompt-restore-cli-prefix").getAttribute("title"),
    ).toBe("settings.systemPrompt.blockedByDraft");
  });

  it("restore shows the built-in default inline and confirms with the revision it captured", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-restore-cli-prefix"));

    const confirm = screen.getByTestId("settings-system-prompt-restore-confirm-cli-prefix");
    expect(within(confirm).getByText("The default prompt")).toBeTruthy();
    fireEvent.click(within(confirm).getByText("settings.systemPrompt.restoreConfirm.confirm"));
    expect(mocks.restoreDefault).toHaveBeenCalledWith("cli-prefix", "rev-cli");
    expect(mocks.requestConfirmation).not.toHaveBeenCalled();
  });

  it("restore declined leaves the override untouched", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-restore-cli-prefix"));
    const confirm = screen.getByTestId("settings-system-prompt-restore-confirm-cli-prefix");
    fireEvent.click(within(confirm).getByText("common.cancel"));
    expect(mocks.restoreDefault).not.toHaveBeenCalled();
    expect(screen.queryByTestId("settings-system-prompt-restore-confirm-cli-prefix")).toBeNull();
  });

  it("reset all lists the affected blocks and passes each confirmed revision", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-reset-all"));
    const panel = screen.getByTestId("settings-system-prompt-reset-all-confirm");
    expect(within(panel).getByText("settings.systemPrompt.section.cliPrefix").tagName).toBe("LI");
    fireEvent.click(within(panel).getByText("settings.systemPrompt.resetAll.confirm"));
    expect(mocks.resetAllCustomized).toHaveBeenCalledWith([
      { key: "cli-prefix", expectedRevision: "rev-cli" },
    ]);
  });

  it("shows the disk-changed state and routes Overwrite and Reload to the hook", () => {
    mocks.diskChanged = true;
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: "mine" },
    });

    expect(screen.getByTestId("settings-system-prompt-disk-changed")).toBeTruthy();
    expect(
      (screen.getByTestId("settings-system-prompt-save-cli-prefix") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-reload"));
    expect(mocks.reloadEditor).toHaveBeenCalledWith("The saved prompt");
    expect(mocks.saveEditor).not.toHaveBeenCalled();
  });

  function openCliDraft(draft = "mine") {
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: draft },
    });
  }

  function overwriteButton() {
    return screen.getByTestId("settings-system-prompt-disk-overwrite") as HTMLButtonElement;
  }

  it("keeps Overwrite disabled until the disk version has been shown", () => {
    mocks.diskChanged = true;
    renderSection();
    openCliDraft();

    expect(overwriteButton().disabled).toBe(true);
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
    expect(screen.getByText("settings.systemPrompt.diskChanged.viewFirst")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(overwriteButton().disabled).toBe(false);
    expect(screen.getByTestId("settings-system-prompt-disk-version").textContent).toBe(
      "The saved prompt",
    );
    expect(mocks.saveEditor).not.toHaveBeenCalled();
  });

  it("shows the conflict's disk version once the listing reports the conflict revision", async () => {
    mocks.diskChanged = true;
    mocks.conflictRevision = "rev-newer";
    mocks.cliRevision = "rev-newer";
    mocks.cliText = "Newer disk text";
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(screen.getByTestId("settings-system-prompt-disk-version").textContent).toBe(
      "Newer disk text",
    );
    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));
    expect(mocks.saveEditor).toHaveBeenCalledWith({ overwrite: { reviewedRevision: "rev-newer" } });
  });

  it("refreshes instead of showing an older revision while the listing lacks the conflict revision", () => {
    mocks.diskChanged = true;
    mocks.conflictRevision = "rev-newer";
    // The refresh after the conflict failed, so the listing still reports the pre-conflict revision.
    mocks.cliRevision = "rev-cli";
    mocks.cliText = "Stale disk text";
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
    expect(overwriteButton().disabled).toBe(true);
    expect(mocks.saveEditor).not.toHaveBeenCalled();
  });

  it("treats a conflict revision of null as a missing file, not as no conflict", async () => {
    mocks.diskChanged = true;
    mocks.conflictRevision = null;
    mocks.cliRevision = null;
    mocks.cliText = null;
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(screen.getByText("settings.systemPrompt.diskChanged.noOverride")).toBeTruthy();
    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));
    expect(mocks.saveEditor).toHaveBeenCalledWith({ overwrite: { reviewedRevision: null } });
  });

  it("does not fall back to a listing revision when the conflict revision is null", () => {
    mocks.diskChanged = true;
    mocks.conflictRevision = null;
    // The listing still shows a file, so it is not the disk version the conflict describes.
    mocks.cliRevision = "rev-cli";
    mocks.cliText = "Stale disk text";
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
    expect(overwriteButton().disabled).toBe(true);
    expect(mocks.saveEditor).not.toHaveBeenCalled();
  });

  it("overwrites with the revision of the disk version that was shown, not the earlier one", async () => {
    mocks.diskChanged = true;
    mocks.cliRevision = "rev-old";
    mocks.cliText = "Old disk text";
    renderSection();
    openCliDraft();

    // The listing moves on after the card appeared, then the user looks at the new disk version.
    mocks.cliRevision = "rev-cli";
    mocks.cliText = "Newer disk text";
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: "mine again" },
    });
    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(screen.getByTestId("settings-system-prompt-disk-version").textContent).toBe(
      "Newer disk text",
    );

    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));
    expect(mocks.saveEditor).toHaveBeenCalledWith({ overwrite: { reviewedRevision: "rev-cli" } });
    expect(mocks.reloadEditor).not.toHaveBeenCalled();
  });

  it("drops the shown version after a conflict and requires viewing the newer one again", async () => {
    mocks.diskChanged = true;
    mocks.saveEditor
      .mockImplementationOnce(async () => {
        // The file changes again before the write lands; the listing then reports the newer revision.
        mocks.cliRevision = "rev-newer";
        mocks.cliText = "Newer disk text";
        act(() => mocks.relist?.());
        return { currentRevision: "rev-newer" };
      })
      .mockResolvedValueOnce(undefined);
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(overwriteButton().disabled).toBe(true));
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
    expect(
      (screen.getByTestId("settings-system-prompt-editor-cli-prefix") as HTMLTextAreaElement).value,
    ).toBe("mine");

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(screen.getByTestId("settings-system-prompt-disk-version").textContent).toBe(
      "Newer disk text",
    );
    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(2));

    expect(mocks.saveEditor).toHaveBeenNthCalledWith(1, {
      overwrite: { reviewedRevision: "rev-cli" },
    });
    expect(mocks.saveEditor).toHaveBeenNthCalledWith(2, {
      overwrite: { reviewedRevision: "rev-newer" },
    });
    expect(mocks.reloadEditor).not.toHaveBeenCalled();
  });

  it("clears the shown version on a conflict even when the listing still reports the same revision", async () => {
    mocks.diskChanged = true;
    mocks.saveEditor.mockResolvedValueOnce({ currentRevision: "rev-cli" });
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(overwriteButton().disabled).toBe(true));
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
  });

  it("leaves the draft untouched when showing the disk version and after a conflict", async () => {
    mocks.diskChanged = true;
    mocks.saveEditor.mockResolvedValueOnce({ currentRevision: "rev-newer" });
    renderSection();
    openCliDraft("my draft");
    const draftField = () =>
      screen.getByTestId("settings-system-prompt-editor-cli-prefix") as HTMLTextAreaElement;

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(draftField().value).toBe("my draft");

    fireEvent.click(overwriteButton());
    await waitFor(() => expect(mocks.saveEditor).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(overwriteButton().disabled).toBe(true));
    expect(draftField().value).toBe("my draft");
    expect(mocks.reloadEditor).not.toHaveBeenCalled();
  });

  it("shows an explicit note when the disk file has no override text", () => {
    mocks.diskChanged = true;
    mocks.cliText = null;
    renderSection();
    openCliDraft();

    fireEvent.click(screen.getByTestId("settings-system-prompt-disk-show"));
    expect(screen.queryByTestId("settings-system-prompt-disk-version")).toBeNull();
    expect(screen.getByText("settings.systemPrompt.diskChanged.noOverride")).toBeTruthy();
    expect(overwriteButton().disabled).toBe(false);
  });

  it("keeps Overwrite available without a view on hosts that report no revision", () => {
    mocks.diskChanged = true;
    mocks.cliRevision = undefined;
    renderSection();
    openCliDraft();

    expect(overwriteButton().disabled).toBe(false);
    fireEvent.click(overwriteButton());
    expect(mocks.saveEditor).toHaveBeenCalledTimes(1);
    expect(mocks.saveEditor.mock.calls[0]?.[0]).toEqual({
      overwrite: { reviewedRevision: undefined },
    });
  });

  it("offers Open folder for local hosts only and reveals the parent directory", async () => {
    renderSection({ workspacePath: "/local/repo" });
    fireEvent.click(screen.getByTestId("settings-system-prompt-open-folder-cli-prefix"));
    await waitFor(() =>
      expect(mocks.openInFileManager).toHaveBeenCalledWith("/remote/.zcode/system-prompt"),
    );
  });

  it("falls back to the parent folder when the overrides folder does not exist yet", async () => {
    mocks.openInFileManager
      .mockResolvedValueOnce({ success: false, error: "missing" })
      .mockResolvedValueOnce({ success: true });
    renderSection({ workspacePath: "/local/repo" });
    fireEvent.click(screen.getByTestId("settings-system-prompt-open-folder-cli-prefix"));
    await waitFor(() => expect(mocks.openInFileManager).toHaveBeenCalledTimes(2));
    expect(mocks.openInFileManager).toHaveBeenNthCalledWith(1, "/remote/.zcode/system-prompt");
    expect(mocks.openInFileManager).toHaveBeenNthCalledWith(2, "/remote/.zcode");
  });

  it("compares a clean editor to the built-in default only when that mode is selected", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));

    expect(screen.getByText("settings.systemPrompt.diffNone")).toBeTruthy();
    expect(screen.queryByTestId("settings-system-prompt-diff-cli-prefix")).toBeNull();

    const modes = screen.getAllByTestId("settings-system-prompt-diff-mode");
    fireEvent.click(modes.find((mode) => mode.getAttribute("data-mode") === "default")!);
    const diff = screen.getByTestId("settings-system-prompt-diff-cli-prefix");
    expect(diff.textContent).toContain("The default prompt");
    expect(diff.textContent).toContain("The saved prompt");
  });

  it("hides Open folder on remote hosts, where the path is not on this computer", () => {
    renderSection(targetA);
    expect(screen.queryByTestId("settings-system-prompt-open-folder-cli-prefix")).toBeNull();
  });

  it("renders the assembled prompt preview as approximate, with its text only once opened", () => {
    renderSection();
    const preview = screen.getByTestId("settings-system-prompt-assembled");
    expect(preview.textContent).toContain("settings.systemPrompt.assembled.title");
    expect(preview.querySelector("pre")).toBeNull();

    preview.setAttribute("open", "");
    fireEvent(preview, new Event("toggle"));
    expect(preview.querySelector("pre")?.textContent).toBe(
      "The saved prompt\n\nHarness default text",
    );
  });

  it("keeps the dirty editor pinned to its original host when a switch is declined", async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = renderSection(targetA, onDirtyChange);
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: "unsaved" },
    });

    rerender(
      createElement(SystemPromptSection, {
        isDesktop: true,
        activeTarget: targetB,
        onDirtyChange,
      }),
    );
    await waitFor(() => expect(mocks.requestConfirmation).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());

    expect(mocks.lastTarget?.workspaceIdentity).toBe("ssh:a");
    expect(screen.getByText(/settings\.systemPrompt\.pinnedHostNotice/)).toBeTruthy();
    expect(
      (screen.getByTestId("settings-system-prompt-editor-cli-prefix") as HTMLTextAreaElement).value,
    ).toBe("unsaved");
  });

  it("switches the pinned editor host and discards its draft after confirmation", async () => {
    mocks.requestConfirmation.mockResolvedValue(true);
    const onDirtyChange = vi.fn();
    const { rerender } = renderSection(targetA, onDirtyChange);
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));
    fireEvent.change(screen.getByTestId("settings-system-prompt-editor-cli-prefix"), {
      target: { value: "unsaved" },
    });

    rerender(
      createElement(SystemPromptSection, {
        isDesktop: true,
        activeTarget: targetB,
        onDirtyChange,
      }),
    );
    await waitFor(() => expect(mocks.lastTarget?.workspaceIdentity).toBe("ssh:b"));
    await waitFor(() =>
      expect(screen.queryByTestId("settings-system-prompt-editor-cli-prefix")).toBeNull(),
    );

    expect(mocks.requestConfirmation).toHaveBeenCalledTimes(1);
  });
});
