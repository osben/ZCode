// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const paneState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      return React.createElement("div", { "data-testid": "session-pane" });
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

import { cleanup, render } from "@testing-library/react";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";

const tab = {
  id: "selection-side-chat:tab",
  type: "selection-side-chat" as const,
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "root-task",
  childSessionId: "child-session",
  ordinal: 1,
};

describe("SelectionSideChatPane dictation surface", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
  });

  it("forwards the desktop flag so the side conversation composer mounts dictation", () => {
    render(
      createElement(SelectionSideChatPane, {
        tab,
        focused: true,
        isDesktop: true,
        onUnavailable: () => undefined,
      }),
    );
    expect(paneState.props?.selectionSideChat).toBe(true);
    expect(paneState.props?.isDesktop).toBe(true);
  });

  it("keeps the desktop flag off when the shell is not desktop", () => {
    render(
      createElement(SelectionSideChatPane, {
        tab,
        focused: true,
        onUnavailable: () => undefined,
      }),
    );
    expect(paneState.props?.isDesktop).toBeFalsy();
  });
});
