// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";
import { WorkbenchLeafPane } from "@/v4/WorkbenchPane.js";

const guardMocks = vi.hoisted(() => {
  let listener: (() => void) | null = null;
  const listSessions = vi.fn();
  const store = {
    getState: () => ({ workspaceId: "/workspace" }),
    getSessions: () => [],
    subscribe: (next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return {
    get listener() {
      return listener;
    },
    listSessions,
    store,
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeAgentService: { listSessions: guardMocks.listSessions } }),
}));

vi.mock("@/v4/sessionsIndexRegistry.js", () => ({
  acquireSessionsIndex: () => guardMocks.store,
  releaseSessionsIndex: vi.fn(),
}));

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return { SessionPane: () => React.createElement("div") };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

let root: Root | null = null;

function renderGuard(onConfirmed: (paneId: string) => void): void {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(WorkbenchLeafPane, {
        paneId: V4_PRIMARY_PANE_ID,
        rect: { left: "0%", top: "0%", width: "100%", height: "100%" },
        focused: true,
        showFocusIndicator: false,
        canSplit: true,
        shellWorkspaceKey: "/workspace",
        binding: null,
        primaryBinding: {
          workspaceScope: { workspacePath: "/workspace" },
          sessionId: "child-session",
          readOnly: true,
          restoredUnvalidated: true,
        },
        shell: { workspacePath: "/workspace", sessionId: "child-session" },
        onFocusRequest: vi.fn(),
        onClosePane: vi.fn(),
        onConfirmRestoredSession: onConfirmed,
        onBindSession: vi.fn(),
      }),
    );
  });
}

describe("PaneRestoredGuard", () => {
  beforeEach(() => {
    guardMocks.listSessions.mockReset();
    guardMocks.listSessions
      .mockRejectedValueOnce(new Error("temporary transport failure"))
      .mockResolvedValue([{ sessionId: "child-session", sessionKind: "subagent_child" }]);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
  });

  it("retries restored subagent validation after a failed lookup and a sessions-index update", async () => {
    const onConfirmed = vi.fn();
    renderGuard(onConfirmed);
    await act(async () => {
      await Promise.resolve();
    });
    expect(guardMocks.listSessions).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      guardMocks.listener?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(guardMocks.listSessions).toHaveBeenCalledTimes(2);
    expect(onConfirmed).toHaveBeenCalledWith(V4_PRIMARY_PANE_ID);
  });
});
