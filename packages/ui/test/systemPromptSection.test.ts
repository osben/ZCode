// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  saveEditor: vi.fn(),
  restoreDefault: vi.fn(),
  lastTarget: null as { workspacePath: string | null; workspaceIdentity?: string } | null,
}));

vi.mock("@/hooks/useSystemPromptOverrides.js", async () => {
  const React = await import("react");
  const section = {
    key: "cli-prefix",
    defaultContent: "The default prompt",
    overrideContent: "The saved prompt",
    filePath: "/remote/.zcode/system-prompt/cli-prefix.md",
    isOverridden: true,
  };
  return {
    useSystemPromptOverrides(target: { workspacePath: string | null; workspaceIdentity?: string }) {
      mocks.lastTarget = target;
      const [editor, setEditor] = React.useState<{
        key: "cli-prefix";
        baseline: string;
        draft: string;
        saving: boolean;
      } | null>(null);
      const [hostKey, setHostKey] = React.useState(target.workspaceIdentity ?? "local");
      React.useEffect(() => {
        const nextHostKey = target.workspaceIdentity ?? "local";
        if (hostKey === nextHostKey) return;
        setHostKey(nextHostKey);
        setEditor(null);
      }, [hostKey, target.workspaceIdentity]);
      const openEditor = (_key: string, effectiveContent: string) => {
        setEditor({
          key: "cli-prefix",
          baseline: effectiveContent,
          draft: effectiveContent,
          saving: false,
        });
      };
      const setDraft = (draft: string) =>
        setEditor((current) => (current ? { ...current, draft } : current));
      const editorDirty = editor !== null && editor.draft !== editor.baseline;
      return {
        hostKey: `remote:${target.workspaceIdentity ?? "local"}`,
        isRemote: true,
        status: "ready",
        sections: [section],
        editor,
        editorDirty,
        canSaveEditor: editorDirty,
        reload: vi.fn(),
        openEditor,
        closeEditor: () => setEditor(null),
        setDraft,
        saveEditor: mocks.saveEditor,
        restoreDefault: mocks.restoreDefault,
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
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string>) =>
        `${descriptor.id}${values?.host ? `:${values.host}` : ""}`,
    },
  }),
}));
vi.mock("@/store/confirmDialogStore.js", () => ({
  useConfirmDialogStore: {
    getState: () => ({ requestConfirmation: mocks.requestConfirmation }),
  },
}));

import { SystemPromptSection } from "../src/settings/SystemPromptSection.js";

const targetA = { workspacePath: "/remote/a", workspaceIdentity: "ssh:a" };
const targetB = { workspacePath: "/remote/b", workspaceIdentity: "ssh:b" };

beforeEach(() => {
  mocks.requestConfirmation.mockReset();
  mocks.saveEditor.mockReset();
  mocks.restoreDefault.mockReset();
  mocks.requestConfirmation.mockResolvedValue(false);
});

afterEach(() => cleanup());

describe("SystemPromptSection", () => {
  it("shows one effective preview and one editor, displays the diff, and confirms restore", async () => {
    mocks.requestConfirmation.mockResolvedValue(true);
    render(
      createElement(SystemPromptSection, {
        isDesktop: true,
        activeTarget: targetA,
        onDirtyChange: vi.fn(),
      }),
    );

    expect(screen.getByTestId("settings-system-prompt-customized-cli-prefix")).toBeTruthy();
    expect(screen.getByText("The saved prompt")).toBeTruthy();
    expect(screen.queryByText("The default prompt")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-system-prompt-restore-cli-prefix"));
    await waitFor(() => expect(mocks.requestConfirmation).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(mocks.restoreDefault).toHaveBeenCalledWith("cli-prefix");
    fireEvent.click(screen.getByTestId("settings-system-prompt-edit-cli-prefix"));

    const editor = screen.getByTestId("settings-system-prompt-editor-cli-prefix");
    expect((editor as HTMLTextAreaElement).value).toBe("The saved prompt");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText("The saved prompt", { selector: "pre" })).toBeNull();
    fireEvent.change(editor, { target: { value: "The edited prompt" } });
    expect(screen.getByTestId("settings-system-prompt-diff-cli-prefix")).toBeTruthy();
    expect(
      (screen.getByTestId("settings-system-prompt-edit-cli-prefix") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("settings-system-prompt-restore-cli-prefix") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("settings-system-prompt-save-cli-prefix"));
    expect(mocks.saveEditor).toHaveBeenCalledTimes(1);
  });

  it("keeps the dirty editor pinned to its original host when a switch is declined", async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      createElement(SystemPromptSection, {
        isDesktop: true,
        activeTarget: targetA,
        onDirtyChange,
      }),
    );
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
    expect(screen.getByText("settings.systemPrompt.pinnedHostNotice:ssh:a")).toBeTruthy();
    expect(
      (screen.getByTestId("settings-system-prompt-editor-cli-prefix") as HTMLTextAreaElement).value,
    ).toBe("unsaved");
  });

  it("switches the pinned editor host and discards its draft after confirmation", async () => {
    mocks.requestConfirmation.mockResolvedValue(true);
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      createElement(SystemPromptSection, {
        isDesktop: true,
        activeTarget: targetA,
        onDirtyChange,
      }),
    );
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
