// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const paneState = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      paneState.props = props;
      const fire = (handler: string, request: Record<string, unknown>) => () =>
        (props[handler] as ((request: Record<string, unknown>) => void) | undefined)?.(request);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", {
          "data-testid": "open-subagent",
          onClick: fire("onOpenSubagentSession", {
            parentSessionId: "child-session",
            childSessionId: "grandchild-session",
            subagentType: "Explore",
            title: "Nested explore",
          }),
        }),
        React.createElement("button", {
          "data-testid": "open-subagent-directory",
          onClick: fire("onOpenSubagentDirectory", { parentSessionId: "child-session" }),
        }),
        React.createElement("button", {
          "data-testid": "sync-subagent-tabs",
          onClick: () =>
            (
              props.onSyncSubagentSessionTabs as
                | ((request: Record<string, unknown>) => void)
                | undefined
            )?.({
              rootSessionId: props.rootSessionId as string,
              parentSessionId: "child-session",
              validChildSessionIds: ["grandchild-session"],
            }),
        }),
        React.createElement("button", {
          "data-testid": "open-background-bash",
          onClick: fire("onOpenBackgroundBash", {
            parentSessionId: "child-session",
            workId: "work-bash",
            title: "Build",
          }),
        }),
      );
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

describe("SelectionSideChatPane subagent hand-off", () => {
  afterEach(() => {
    cleanup();
    paneState.props = null;
  });

  it("scopes child tabs to the main task and forwards every subagent handler", () => {
    const onOpenSubagentSession = vi.fn();
    const onOpenSubagentDirectory = vi.fn();
    const onSyncSubagentSessionTabs = vi.fn();
    const onOpenBackgroundBash = vi.fn();
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
        onOpenSubagentSession,
        onOpenSubagentDirectory,
        onSyncSubagentSessionTabs,
        onOpenBackgroundBash,
      }),
    );

    // The side chat's subagents belong to the main task, so the pane's conversation group root must be
    // the tab's parent (the main task), not the side chat session id.
    expect(paneState.props).toMatchObject({
      paneId: tab.id,
      sessionId: "child-session",
      rootSessionId: "root-task",
    });
    expect(paneState.props?.onOpenSubagentSession).toBe(onOpenSubagentSession);
    expect(paneState.props?.onOpenSubagentDirectory).toBe(onOpenSubagentDirectory);
    expect(paneState.props?.onSyncSubagentSessionTabs).toBe(onSyncSubagentSessionTabs);
    expect(paneState.props?.onOpenBackgroundBash).toBe(onOpenBackgroundBash);

    fireEvent.click(view.getByTestId("open-subagent"));
    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      parentSessionId: "child-session",
      childSessionId: "grandchild-session",
      subagentType: "Explore",
      title: "Nested explore",
    });

    fireEvent.click(view.getByTestId("open-subagent-directory"));
    expect(onOpenSubagentDirectory).toHaveBeenCalledWith({ parentSessionId: "child-session" });

    // Sync must keep the main-task root so the collector only prunes tabs owned by this side chat.
    fireEvent.click(view.getByTestId("sync-subagent-tabs"));
    expect(onSyncSubagentSessionTabs).toHaveBeenCalledWith({
      rootSessionId: "root-task",
      parentSessionId: "child-session",
      validChildSessionIds: ["grandchild-session"],
    });

    fireEvent.click(view.getByTestId("open-background-bash"));
    expect(onOpenBackgroundBash).toHaveBeenCalledWith({
      parentSessionId: "child-session",
      workId: "work-bash",
      title: "Build",
    });
  });
});
