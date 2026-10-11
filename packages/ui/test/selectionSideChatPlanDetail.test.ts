// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const paneState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      return React.createElement("button", {
        "data-testid": "open-plan",
        onClick: () =>
          (props.onOpenPlanDetail as ((request: Record<string, unknown>) => void) | undefined)?.({
            workspacePath: "/workspace",
            parentSessionId: "child-session",
            toolCallId: "plan-tool",
            markdown: "# Side-chat plan",
          }),
      });
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

import { cleanup, fireEvent, render } from "@testing-library/react";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";

describe("SelectionSideChatPane plan detail", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
  });

  it("passes plan detail opens through with the owning root task scope", () => {
    const requests: Record<string, unknown>[] = [];
    const tab = {
      id: "selection-side-chat:tab",
      type: "selection-side-chat" as const,
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      parentSessionId: "root-task",
      childSessionId: "child-session",
      ordinal: 1,
    };
    const view = render(
      createElement(SelectionSideChatPane, {
        tab,
        focused: true,
        onUnavailable: () => undefined,
        onOpenPlanDetail: (request) => requests.push(request),
      }),
    );

    fireEvent.click(view.getByTestId("open-plan"));

    expect(paneState.props).toMatchObject({
      paneId: tab.id,
      sessionId: "child-session",
    });
    expect(requests).toEqual([
      {
        workspacePath: "/workspace",
        parentSessionId: "child-session",
        toolCallId: "plan-tool",
        markdown: "# Side-chat plan",
        rootSessionId: "root-task",
      },
    ]);
  });
});
