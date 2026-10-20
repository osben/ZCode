// @vitest-environment jsdom
import { createElement } from "react";

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TID_ASSISTANT_CODE_COMMENT_ITEM, TID_ASSISTANT_CODE_COMMENT_TOGGLE } from "@zcode/shared";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TEST_LOCALE } from "./helpers/uiCopy.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
} from "@/lib/assistantCodeComment.js";

describe("web remote control Assistant code-comment capability", () => {
  it("终态 replay row 通过共享投影隐藏 directive，并保留 remote review scope", () => {
    const assistantText =
      '已完成审查。\n::code-comment{title="[P1] 检查入口" body="请检查启动路径" file="src/main.ts" start=12 end=14 priority=1}';
    const workspacePath = "/remote/workspace";
    const workspaceIdentity = "remote:ssh:demo:/remote/workspace";
    const workspaceRemoteSessionId = "remote-session-1";
    const projection = projectAssistantCodeComments(assistantText, { streaming: false });
    const cards = buildAssistantCodeCommentCards(assistantText, workspacePath);
    const onOpenCodeViewer = vi.fn();

    expect(projection.visibleText).toBe("已完成审查。\n");
    expect(projection.visibleText).not.toContain("::code-comment");
    expect(cards).toHaveLength(1);

    const { getByTestId } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(AssistantCodeCommentCards, {
          cards,
          workspacePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          onOpenCodeViewer,
        }),
      ),
    );

    fireEvent.click(getByTestId(TID_ASSISTANT_CODE_COMMENT_TOGGLE));
    const commentCard = getByTestId(TID_ASSISTANT_CODE_COMMENT_ITEM);
    fireEvent.click(commentCard);

    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code-review",
        path: "/remote/workspace/src/main.ts",
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
        review: expect.objectContaining({
          title: "检查入口",
          body: "请检查启动路径",
          startLine: 12,
          endLine: 14,
        }),
      }),
    );
  });
});
