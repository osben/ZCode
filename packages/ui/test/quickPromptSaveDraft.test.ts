// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IQuickPromptService, QuickPromptSnapshot } from "@zcode/services";
import { QuickPromptBar } from "@/quick-prompts/QuickPromptBar.js";
import { QuickPromptSavePopover } from "@/quick-prompts/QuickPromptSavePopover.js";

// Spec: specs/composer-quick-prompts.md (rules 3, 14, 15). "Save draft" is for text only: attachments and contexts
// are never part of a quick prompt, so a draft with only those must not offer to save an empty body.

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

describe("quick prompt Save draft chip (spec rule 3, rule 14)", () => {
  it("shows the add chip, not Save draft, when the draft holds only attachments", () => {
    renderBar({ draftHasText: false, draftHasContent: true });
    expect(screen.queryByTestId("quick-prompt-save-draft")).toBeNull();
    expect(screen.getByLabelText("quickPrompts.add")).toBeTruthy();
  });

  it("offers Save draft once the editor has text", () => {
    renderBar({ draftHasText: true, draftHasContent: true });
    expect(screen.getByTestId("quick-prompt-save-draft")).toBeTruthy();
  });
});

describe("quick prompt save popover refuses an empty body (spec rule 15)", () => {
  it("disables Save while the editor body is blank, and enables it for text", async () => {
    const handle = handleWithBody("   ");
    const service = { create: vi.fn(async () => ({})) };
    const { rerender } = render(
      createElement(QuickPromptSavePopover, {
        open: true,
        onOpenChange: vi.fn(),
        service: service as unknown as IQuickPromptService,
        project: null,
        snapshot: emptySnapshot,
        inputApiRef: { current: handle } as never,
        refresh: vi.fn(async () => undefined),
        onMoreOptions: vi.fn(),
        children: createElement("button", { type: "button" }, "trigger"),
      }),
    );

    // A valid name leaves the body as the only reason Save can be disabled.
    await waitFor(() => expect(screen.getByTestId("quick-prompt-save-name")).toBeTruthy());
    fireEvent.change(screen.getByTestId("quick-prompt-save-name"), { target: { value: "Typed" } });
    expect((screen.getByTestId("quick-prompt-save-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(service.create).not.toHaveBeenCalled();

    handle.getSerializedBody.mockReturnValue({
      markdown: "review",
      nodes: JSON.stringify([{ type: "paragraph", version: 1, children: [] }]),
    });
    rerender(
      createElement(QuickPromptSavePopover, {
        open: false,
        onOpenChange: vi.fn(),
        service: service as unknown as IQuickPromptService,
        project: null,
        snapshot: emptySnapshot,
        inputApiRef: { current: handle } as never,
        refresh: vi.fn(async () => undefined),
        onMoreOptions: vi.fn(),
        children: createElement("button", { type: "button" }, "trigger"),
      }),
    );
    rerender(
      createElement(QuickPromptSavePopover, {
        open: true,
        onOpenChange: vi.fn(),
        service: service as unknown as IQuickPromptService,
        project: null,
        snapshot: emptySnapshot,
        inputApiRef: { current: handle } as never,
        refresh: vi.fn(async () => undefined),
        onMoreOptions: vi.fn(),
        children: createElement("button", { type: "button" }, "trigger"),
      }),
    );
    await waitFor(() =>
      expect((screen.getByTestId("quick-prompt-save-submit") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("quick-prompt-save-submit"));
    await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1));
  });
});
