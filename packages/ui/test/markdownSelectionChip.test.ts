// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import {
  parsePromptConversationSelections,
  buildPromptWithConversationSelections,
} from "@/lib/conversationSelectionReference.js";

afterEach(cleanup);
it.each(["/workspace/docs/a.md", "C:\\docs\\a.md"])(
  "历史引用显示文件名和完整路径：%s",
  async (path) => {
    const { references } = parsePromptConversationSelections(
      buildPromptWithConversationSelections("Explain", [{ path, text: "excerpt" }]),
    );
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationSelectionReferenceChip, { references }),
      ),
    );
    const chip = document.querySelector('[data-conversation-selection-reference-count="1"]')!;
    fireEvent.pointerEnter(chip);
    const content = await screen.findByText(
      (_, element) => element?.classList.contains("max-h-64") ?? false,
    );
    expect(content.textContent).toContain(path);
    expect(content.textContent).toContain("excerpt");
  },
);
it("混合引用使用通用计数", () => {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationSelectionReferenceChip, {
        references: [{ path: "a.md", text: "file" }, { text: "message" }],
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "2 selections" })).toBeTruthy();
});
