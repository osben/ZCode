// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

function card(index: number): AssistantCodeCommentCard {
  return {
    id: `comment-${index}`,
    title: `[P1] Risk ${index}`,
    body: `Fix needed ${index}`,
    file: `src/file-${index}.ts`,
    path: `/workspace/src/file-${index}.ts`,
    displayPath: `src/file-${index}.ts`,
    priority: 1,
    startLine: index,
    endLine: index + 1,
    sourceStart: index,
    sourceEnd: index + 1,
  };
}

describe("AssistantCodeCommentCards", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("is collapsed by default; each comment occupies one row without the body; text is selectable and a plain-row click opens the readonly code review", () => {
    const onOpenCodeViewer = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(AssistantCodeCommentCards, {
          cards: Array.from({ length: 7 }, (_, index) => card(index + 1)),
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:demo:/workspace",
          workspaceRemoteSessionId: "remote-1",
          onOpenCodeViewer,
        }),
      ),
    );

    expect(screen.getByText(expectedCopy("chat.codeComments.other", { count: 7 }))).toBeTruthy();
    expect(screen.queryByText("Risk 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show 7 comments/ }));
    expect(screen.getByText("Risk 1")).toBeTruthy();
    expect(screen.getByText("Risk 6")).toBeTruthy();
    expect(screen.queryByText("Fix needed 1")).toBeNull();

    const firstCard = screen.getByRole("button", { name: /Risk 1/ });
    expect(screen.getByText("src/file-1.ts:1–2")).toBeTruthy();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Risk 1"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(firstCard);
    expect(onOpenCodeViewer).not.toHaveBeenCalled();

    selection?.removeAllRanges();
    fireEvent.click(firstCard);
    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code-review",
        title: "file-1.ts",
        path: "/workspace/src/file-1.ts",
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:demo:/workspace",
        workspaceRemoteSessionId: "remote-1",
        review: {
          requestId: expect.stringContaining("comment-1:"),
          title: "Risk 1",
          body: "Fix needed 1",
          priority: 1,
          startLine: 1,
          endLine: 2,
        },
      }),
    );

    fireEvent.keyDown(firstCard, { key: "Enter" });
    fireEvent.keyDown(firstCard, { key: " " });
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(3);
  });
});
