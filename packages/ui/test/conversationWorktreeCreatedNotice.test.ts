// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en-US.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationWorktreeCreatedNotice } from "@/v4/ConversationWorktreeCreatedNotice.js";

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

afterEach(() => {
  cleanup();
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
    const onOpenWorktree = vi.fn();
    renderNotice({
      path: "/home/dev/repo/.worktrees/feature-a",
      workspaceIdentity: "remote:ssh:devbox:22:dev:/home/dev/repo",
      onOpenWorktree,
    });

    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));

    await waitFor(() => expect(onOpenWorktree).toHaveBeenCalledTimes(1));
    expect(onOpenWorktree).toHaveBeenCalledWith(
      "/home/dev/repo/.worktrees/feature-a",
      "remote:ssh:devbox:22:dev:/home/dev/repo/.worktrees/feature-a",
    );
  });

  it("renders no open action when no open callback is provided", () => {
    renderNotice({ path: "/Users/dev/repo/.worktrees/feature-a" });

    expect(screen.queryByRole("button", { name: OPEN_LABEL })).toBeNull();
  });
});
