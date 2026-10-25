// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
} from "@/lib/assistantCodeComment.js";

describe("web remote control Assistant code-comment capability", () => {
  it("terminal replay row hides the directive through the shared projection and keeps the remote review scope", () => {
    const assistantText =
      'Review complete.\n::code-comment{title="[P1] Check entry" body="Check the startup path" file="src/main.ts" start=12 end=14 priority=1}';
    const workspacePath = "/remote/workspace";
    const workspaceIdentity = "remote:ssh:demo:/remote/workspace";
    const workspaceRemoteSessionId = "remote-session-1";
    const projection = projectAssistantCodeComments(assistantText, { streaming: false });
    const cards = buildAssistantCodeCommentCards(assistantText, workspacePath);
    const onOpenCodeViewer = vi.fn();

    expect(projection.visibleText).toBe("Review complete.\n");
    expect(cards).toHaveLength(1);

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(AssistantCodeCommentCards, {
          cards,
          workspacePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          onOpenCodeViewer,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Show 1 comments/ }));
    fireEvent.click(screen.getByRole("button", { name: /Check entry/ }));

    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code-review",
        path: "/remote/workspace/src/main.ts",
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
        review: expect.objectContaining({
          title: "Check entry",
          body: "Check the startup path",
          startLine: 12,
          endLine: 14,
        }),
      }),
    );
  });
});
