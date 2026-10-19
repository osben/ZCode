// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en-US.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { ConversationWorktreeCreatedNotice } from "@/v4/ConversationWorktreeCreatedNotice.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import type { IServiceAccessor } from "@zcode/services";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createElement("span", { "data-testid": "tooltip-content" }, children),
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const OPEN_LABEL = en["commandCenter.worktree.openExisting"];

function renderNotice(props: {
  path: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  onOpenWorktree?: (path: string, workspaceIdentity?: string) => void | Promise<void>;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationWorktreeCreatedNotice, {
        branchName: "feature-a",
        ...props,
      }),
    ),
  );
}

const REMOTE_PARENT_IDENTITY = "remote:ssh:devbox:22:dev:/home/dev/repo";
const REMOTE_WORKTREE_PATH = "/home/dev/repo/.worktrees/feature-a";
const REMOTE_WORKTREE_IDENTITY = "remote:ssh:devbox:22:dev:/home/dev/repo/.worktrees/feature-a";

function registerAttachedSession(sessionId: string) {
  // Only the session registry matters for the attachment check; the services are never read here.
  registerRemoteWorkspaceSession({ sessionId, services: {} as IServiceAccessor });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Remote session registry and identity bindings are module-level state shared across tests.
  for (const sessionId of Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    unregisterRemoteWorkspaceSession(sessionId);
  }
  useRemoteWorkspaceSessionStore.setState({
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
});

describe("ConversationWorktreeCreatedNotice open action", () => {
  it("opens a local worktree by path with no workspace identity", async () => {
    const onOpenWorktree = vi.fn();
    renderNotice({ path: "/Users/dev/repo/.worktrees/feature-a", onOpenWorktree });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(onOpenWorktree).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).toHaveBeenCalledWith("/Users/dev/repo/.worktrees/feature-a", undefined);
  });

  it("opens a remote-workspace worktree with a remote identity for its own path", async () => {
    registerAttachedSession("session-devbox");
    const onOpenWorktree = vi.fn();
    renderNotice({
      path: REMOTE_WORKTREE_PATH,
      workspaceIdentity: REMOTE_PARENT_IDENTITY,
      remoteSessionId: "session-devbox",
      onOpenWorktree,
    });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(onOpenWorktree).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).toHaveBeenCalledWith(REMOTE_WORKTREE_PATH, REMOTE_WORKTREE_IDENTITY);
    // The rebased identity is bound to the parent's session before the open callback runs.
    expect(
      useRemoteWorkspaceSessionStore.getState().sessionIdByWorkspaceIdentity[
        REMOTE_WORKTREE_IDENTITY
      ],
    ).toBe("session-devbox");
  });

  it("fails closed when the parent keeps its remote session id but the session is no longer attached", async () => {
    // A disconnected tab keeps remoteSessionId while the session registry no longer has it.
    registerAttachedSession("session-devbox");
    unregisterRemoteWorkspaceSession("session-devbox");
    const onOpenWorktree = vi.fn();
    renderNotice({
      path: REMOTE_WORKTREE_PATH,
      workspaceIdentity: REMOTE_PARENT_IDENTITY,
      remoteSessionId: "session-devbox",
      onOpenWorktree,
    });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast).mock.calls[0]?.[0])).toContain(REMOTE_WORKTREE_PATH);
    // The attachment check runs before the bind, so a failed open leaves no identity binding.
    expect(
      useRemoteWorkspaceSessionStore.getState().sessionIdByWorkspaceIdentity[
        REMOTE_WORKTREE_IDENTITY
      ],
    ).toBeUndefined();
  });

  it("fails closed for a remote parent whose session is not bound yet", async () => {
    const path = "/home/dev/repo/.worktrees/feature-a";
    const onOpenWorktree = vi.fn();
    renderNotice({
      path,
      workspaceIdentity: "remote:ssh:devbox:22:dev:/home/dev/repo",
      onOpenWorktree,
    });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast).mock.calls[0]?.[0])).toContain(path);
  });

  it("fails closed for an unparseable remote identity instead of opening the path locally", async () => {
    const path = "/home/dev/repo/.worktrees/feature-a";
    const onOpenWorktree = vi.fn();
    renderNotice({ path, workspaceIdentity: "remote:ssh:devbox:22:dev", onOpenWorktree });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast).mock.calls[0]?.[0])).toContain(path);
  });

  it("shows a failure toast with the exact path when the open callback rejects", async () => {
    const path = "/Users/dev/repo/.worktrees/feature-a";
    const onOpenWorktree = vi.fn().mockRejectedValue(new Error("workspace unavailable"));
    renderNotice({ path, onOpenWorktree });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(toast).mock.calls[0]?.[0])).toContain(path);
  });

  it("renders no open action when no open callback is provided", () => {
    renderNotice({ path: "/Users/dev/repo/.worktrees/feature-a" });

    expect(screen.queryByRole("button", { name: OPEN_LABEL })).toBeNull();
  });
});
