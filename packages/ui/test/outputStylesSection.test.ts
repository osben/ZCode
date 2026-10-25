// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useOutputStyles.js", () => ({
  useOutputStyles: () => ({
    hostKey: "local",
    isRemote: false,
    status: "ready",
    styles: [
      {
        id: "default",
        name: "Default",
        description: "Completes coding tasks efficiently and provides concise responses",
        content: "",
        isBuiltIn: true,
        isOverridden: true,
        filePath: "/home/.zcode/output-styles/default.md",
        enabled: true,
      },
    ],
    stylesDirectory: null,
    activeStyleId: "default",
    activatingStyleId: null,
    editor: null,
    editorDirty: false,
    canSaveEditor: false,
    reload: vi.fn(),
    activate: vi.fn(),
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
    setDraft: vi.fn(),
    saveEditor: vi.fn(),
    resolveConflict: vi.fn(),
    deleteStyle: vi.fn(),
    restoreDefault: vi.fn(),
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openInFileManager: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

import {
  TID_SETTINGS_OUTPUT_STYLES_DEFAULT_PROMPT,
  TID_SETTINGS_OUTPUT_STYLES_ROW,
} from "@zcode/shared";
import { OutputStylesSection } from "../src/settings/OutputStylesSection.js";

afterEach(() => cleanup());

describe("OutputStylesSection", () => {
  it("shows Default prompt contents read-only with no edit or delete actions", () => {
    render(
      createElement(OutputStylesSection, {
        isDesktop: true,
        activeTarget: { workspacePath: null },
        onDirtyChange: vi.fn(),
      }),
    );

    const row = screen.getByTestId(TID_SETTINGS_OUTPUT_STYLES_ROW);
    expect(within(row).getByTestId(TID_SETTINGS_OUTPUT_STYLES_DEFAULT_PROMPT).textContent).toBe(
      "settings.outputStyles.defaultPrompt",
    );
    expect(within(row).queryByRole("button", { name: "settings.outputStyles.edit" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "settings.outputStyles.delete" })).toBeNull();
    expect(
      within(row).queryByRole("button", { name: "settings.outputStyles.restoreDefault" }),
    ).toBeNull();
    expect(within(row).queryByText("settings.outputStyles.overriddenTag")).toBeNull();
  });
});
