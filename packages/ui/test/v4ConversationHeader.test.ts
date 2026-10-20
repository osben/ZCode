import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_V4_PANE_WORKSPACE_BADGE,
  TID_V4_SPLIT_CLOSE,
  TID_V4_SPLIT_DOWN,
  TID_V4_SPLIT_OPEN,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationHeader } from "@/v4/ConversationHeader.js";

function renderHeader(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationHeader, {
        title: "What is this project",
        onSplitRight: vi.fn(),
        onSplitDown: vi.fn(),
        onClosePane: vi.fn(),
        workspaceBadge: {
          label: "workspace",
          workspacePath: "/tmp/workspace",
          remote: false,
        },
        ...overrides,
      }),
    ),
  );
}

describe("ConversationHeader split chrome", () => {
  it("temporarily hides split controls while keeping the other floating pane actions", () => {
    const html = renderHeader();

    expect(html).toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
    expect(html).toContain(`data-testid="${TID_V4_SPLIT_CLOSE}"`);
    expect(html).toContain(`data-testid="${TID_V4_PANE_WORKSPACE_BADGE}"`);
  });

  it("does not render an empty floating action group when only split callbacks are provided", () => {
    const html = renderHeader({
      workspaceBadge: undefined,
      onClosePane: undefined,
    });

    expect(html).not.toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
  });
});
