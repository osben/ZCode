// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IQuickPromptService, QuickPromptSnapshot } from "@zcode/services";
import { QuickPromptBar } from "@/quick-prompts/QuickPromptBar.js";

// Spec: specs/composer-quick-prompts.md (rules 3, 14). The row's last chip is always "+", whatever the draft holds;
// there is no "Save draft" shortcut.

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/mobileTextInput.js", () => ({ useIsMobileTextInputViewport: () => false }));
vi.mock("@/project-sidebar/index.js", () => ({ useOptionalProjectDirectory: () => null }));

const emptySnapshot: QuickPromptSnapshot = { project: null, globals: [], projectPrompts: [] };

function handleWithBody(markdown: string) {
  return {
    getSerializedBody: vi.fn(() => ({
      markdown,
      nodes: JSON.stringify(
        markdown
          ? [
              {
                type: "paragraph",
                version: 1,
                children: [{ type: "text", text: markdown, version: 1 }],
              },
            ]
          : [],
      ),
    })),
    insertSerializedBody: vi.fn(),
    getMarkdown: vi.fn(() => markdown),
  };
}

function renderBar(options: { draftHasText: boolean; draftHasContent: boolean }) {
  const handle = handleWithBody(options.draftHasText ? "review the diff" : "");
  render(
    createElement(QuickPromptBar, {
      snapshot: emptySnapshot,
      project: null,
      service: {} as IQuickPromptService,
      refresh: vi.fn(async () => undefined),
      inputApiRef: { current: handle } as never,
      draftHasContent: options.draftHasContent,
      onSendMarkdown: vi.fn(),
      workspacePath: "/repo",
    }),
  );
  return handle;
}

afterEach(() => {
  cleanup();
});

describe("quick prompt add chip (spec rules 3, 14)", () => {
  it.each([
    { draftHasText: false, draftHasContent: false },
    { draftHasText: false, draftHasContent: true },
    { draftHasText: true, draftHasContent: true },
  ])("shows the add chip and no Save draft for draft %o", (draft) => {
    renderBar(draft);
    expect(screen.queryByTestId("quick-prompt-save-draft")).toBeNull();
    expect(screen.getByTestId("quick-prompt-add")).toBeTruthy();
  });
});
