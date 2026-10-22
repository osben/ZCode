// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/locales/en-US.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { ConversationWorktreeCreatedNotice } from "@/v4/ConversationWorktreeCreatedNotice.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import type { EditorInfo, IPlatformService } from "@zcode/shared";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createElement("span", { "data-testid": "tooltip-content" }, children),
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

const ACTIONS_LABEL = en["worktreeSetup.actions"];

function renderNotice(
  props: {
    path: string;
    branchName?: string;
    currentBranchName?: string | null;
    workspaceIdentity?: string;
    remoteSessionId?: string | null;
    homePath?: string;
  },
  platform?: IPlatformService,
) {
  const notice = createElement(ConversationWorktreeCreatedNotice, {
    branchName: "feature-a",
    ...props,
  });
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      platform ? createElement(PlatformProvider, { platform }, notice) : notice,
    ),
  );
}

function openActionsMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: ACTIONS_LABEL }), {
    button: 0,
    ctrlKey: false,
  });
}

const VSCODE: EditorInfo = { id: "vscode", name: "VS Code", iconDataUrl: "data:," };
const FINDER: EditorInfo = { id: "finder", name: "Finder", iconDataUrl: "data:," };

function createDesktopPlatform(editors: EditorInfo[] = [FINDER, VSCODE]) {
  return {
    canOpenLocalFiles: true,
    getInstalledEditors: vi.fn().mockResolvedValue(editors),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as IPlatformService & {
    openInFileManager: ReturnType<typeof vi.fn>;
    openInEditor: ReturnType<typeof vi.fn>;
  };
}

const REMOTE_PARENT_IDENTITY = "remote:ssh:devbox:22:dev:/home/dev/repo";
const REMOTE_WORKTREE_PATH = "/home/dev/repo/.worktrees/feature-a";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConversationWorktreeCreatedNotice presentation", () => {
  it("titles the row 'Worktree · <branch>' without the created word", () => {
    renderNotice({ path: "/Users/dev/repo/.worktrees/feature-a" });

    const summary = document.querySelector("[data-worktree-created-summary]");
    expect(summary?.textContent).toBe("feature-a");
    expect(screen.getByText(en["worktreeSetup.collapsibleLabel"])).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/created/i);
  });

  it("follows the current branch and keeps the detached HEAD text", () => {
    renderNotice({ path: "/Users/dev/wt", currentBranchName: "Detached HEAD" });

    expect(document.querySelector("[data-worktree-created-summary]")?.textContent).toBe(
      "Detached HEAD",
    );
  });

  it("shortens the path against the Host home and keeps the full path in the tooltip", () => {
    const path = "/Users/dev/repo-worktrees/feature-a";
    renderNotice({ path, homePath: "/Users/dev" });

    fireEvent.click(screen.getByText(en["worktreeSetup.collapsibleLabel"]));

    const pathText = document.querySelector("[data-worktree-created-path]");
    expect(pathText?.textContent).toBe("~/repo-worktrees/feature-a");
    expect(screen.getAllByTestId("tooltip-content").some((node) => node.textContent === path)).toBe(
      true,
    );
  });

  it("keeps the details inside the column: indented with ml-2 and never also w-full", () => {
    renderNotice({ path: "/Users/dev/wt" });

    fireEvent.click(screen.getByText(en["worktreeSetup.collapsibleLabel"]));

    const details = document.querySelector<HTMLElement>("[data-worktree-created-details]");
    expect(details?.className.split(/\s+/)).toContain("ml-2");
    expect(details?.className.split(/\s+/)).not.toContain("w-full");
    expect(
      document.querySelector("[data-worktree-created-command]")?.className.split(/\s+/),
    ).not.toContain("w-full");
  });

  it("copies the git command from the details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderNotice({ path: "/Users/dev/wt" });

    fireEvent.click(screen.getByText(en["worktreeSetup.collapsibleLabel"]));
    fireEvent.click(screen.getByRole("button", { name: en["worktreeSetup.copyCommand"] }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("git worktree add -b feature-a -- /Users/dev/wt"),
    );
    expect(toast).toHaveBeenCalledWith(en["worktreeSetup.commandCopied"]);
  });
});

describe("ConversationWorktreeCreatedNotice actions menu", () => {
  const PATH = "/Users/dev/repo-worktrees/feature-a";

  it("reveals the worktree directory itself in the file manager on desktop", async () => {
    const platform = createDesktopPlatform();
    renderNotice({ path: PATH }, platform);

    openActionsMenu();
    const reveal = screen
      .getAllByRole("menuitem")
      .find((item) => /Open in (Finder|File Explorer|File Manager)/.test(item.textContent ?? ""));
    expect(reveal).toBeTruthy();
    fireEvent.click(reveal!);

    await waitFor(() => expect(platform.openInFileManager).toHaveBeenCalledWith(PATH));
  });

  it("opens the worktree in the last selected code editor, never a file manager", async () => {
    const platform = createDesktopPlatform();
    renderNotice({ path: PATH }, platform);

    openActionsMenu();
    const item = await screen.findByRole("menuitem", { name: "Open in VS Code" });
    expect(screen.queryByRole("menuitem", { name: "Open in Finder" })).toBeNull();
    fireEvent.click(item);

    await waitFor(() =>
      expect(platform.openInEditor).toHaveBeenCalledWith("vscode", PATH, {
        pathKind: "directory",
      }),
    );
  });

  it("copies the absolute path even when the label is shortened", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderNotice({ path: PATH, homePath: "/Users/dev" });

    openActionsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: en["appHeader.copyPath"] }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PATH));
    expect(toast).toHaveBeenCalledWith(en["worktreeSetup.pathCopied"]);
  });

  it("hides reveal and editor items where the platform cannot open local files (Web)", () => {
    renderNotice({ path: PATH });

    openActionsMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      en["appHeader.copyPath"],
    ]);
  });

  it("offers no new-task item: a path-only draft has no project (spec, Timeline presentation)", async () => {
    renderNotice({ path: PATH }, createDesktopPlatform());

    openActionsMenu();
    await screen.findByRole("menuitem", { name: "Open in VS Code" });
    expect(screen.queryByRole("menuitem", { name: /new task/i })).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("hides reveal and editor items for a remote parent workspace even on desktop", async () => {
    const platform = createDesktopPlatform();
    renderNotice(
      { path: REMOTE_WORKTREE_PATH, workspaceIdentity: REMOTE_PARENT_IDENTITY },
      platform,
    );

    openActionsMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      en["appHeader.copyPath"],
    ]);
    expect(platform.getInstalledEditors).not.toHaveBeenCalled();
  });
});
