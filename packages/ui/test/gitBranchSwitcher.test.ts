import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ChevronDownIcon: createIcon("chevron-down"),
    GitBranchIcon: createIcon("git-branch"),
    GitGraph: createIcon("git-graph"),
    LoaderIcon: createIcon("loader"),
    PlusIcon: createIcon("plus"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/command.js", () => ({
  Command: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CommandEmpty: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CommandGroup: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CommandInput: (props: Record<string, unknown>) => createElement("input", props),
  CommandItem: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  CommandList: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "popover" }, children),
  PopoverContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "popover-content" }, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/git-branch-switcher/GitBranchDialogs.js", () => ({
  GitBranchCreateDialog: () => null,
  GitBranchSwitchAssistDialog: () => null,
}));

vi.mock("@/git-graph/GitGraphDialog.js", () => ({
  GitGraphDialog: () => null,
}));

const mocks = vi.hoisted(() => {
  const defaultSwitcherResult = () => ({
    branchesResult: null,
    closeSwitchAssistDialog: vi.fn(),
    commitAndSwitchBranch: vi.fn(),
    commitError: null,
    commitMessage: "",
    createBranchAndSwitch: vi.fn(),
    createBranchName: "",
    createDialogOpen: false,
    gitGraphDialogOpen: false,
    loadingBranches: false,
    mutationPending: false,
    open: false,
    openSwitchCommitDialog: vi.fn(),
    setCommitMessage: vi.fn(),
    setCreateBranchName: vi.fn(),
    setCreateDialogOpen: vi.fn(),
    setGitGraphDialogOpen: vi.fn(),
    setOpen: vi.fn(),
    switchAssistState: null,
    switchAssistStep: "commit",
    switchBranch: vi.fn(),
    worktreeOccupancy: new Map<string, string>(),
  });
  return { defaultSwitcherResult, switcherResult: defaultSwitcherResult() };
});

vi.mock("@/hooks/useGitBranchSwitcher.js", () => ({
  useGitBranchSwitcher: () => mocks.switcherResult,
}));

vi.mock("@/i18n/IntlProvider.js", async () => {
  const { createIntl } = await import("@/i18n/createIntl.js");
  const enUS = (await import("@/i18n/locales/en-US.js")).default;
  return {
    useZCodeIntl: () => ({
      intl: createIntl("en-US", { "en-US": enUS }),
      locale: "en-US",
    }),
  };
});

afterEach(() => {
  mocks.switcherResult = mocks.defaultSwitcherResult();
});

describe("GitBranchSwitcher", () => {
  it("marks the primary branch icon separately from trailing status icons", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).toContain('data-branch-switcher-primary-icon="true"');
    expect(html).toContain('data-branch-switcher-trailing-icon="true"');
    expect(html).toContain("main");
  });

  it("keeps the primary branch icon in compact remote mode", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        compactForRemoteControl: true,
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).toContain('data-branch-switcher-primary-icon="true"');
    expect(html).not.toContain('data-branch-switcher-trailing-icon="true"');
    expect(html).not.toContain("main");
  });

  it("can hide branch creation and graph footer actions", async () => {
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const html = renderToStaticMarkup(
      createElement(GitBranchSwitcher, {
        dirtyFileCount: 0,
        gitSummary: {
          branchName: "main",
          headRefType: "branch",
          isGitAvailable: true,
          isRepository: true,
        },
        onRefreshGit: vi.fn(),
        showFooterActions: false,
        workspacePath: "/workspace/zcode-cli",
      }),
    );

    expect(html).not.toContain("git.branchSwitcher.createAction");
    expect(html).not.toContain("gitGraph.menuAction");
  });

  // The dirty-count label uses the formatPlural key family (git.branchSwitcher.currentDirty.*),
  // so "1 file" must render in the singular and "2 files" in the plural, without raw templates.
  it("renders the uncommitted-changes count with the correct plural form", async () => {
    mocks.switcherResult = {
      ...mocks.switcherResult,
      branchesResult: {
        headRefType: "branch",
        currentBranchName: "main",
        branches: [
          {
            name: "main",
            isCurrent: true,
            upstreamName: null,
            commitHash: null,
            commitTimestampMs: null,
          },
        ],
      },
    };
    const { GitBranchSwitcher } = await import("@/GitBranchSwitcher.js");

    const renderDirtyHtml = (dirtyFileCount: number) =>
      renderToStaticMarkup(
        createElement(GitBranchSwitcher, {
          dirtyFileCount,
          gitSummary: {
            branchName: "main",
            headRefType: "branch",
            isGitAvailable: true,
            isRepository: true,
          },
          onRefreshGit: vi.fn(),
          workspacePath: "/workspace/zcode-cli",
        }),
      );

    const singular = renderDirtyHtml(1);
    expect(singular).toContain("Uncommitted changes: 1 file");
    expect(singular).not.toContain("1 files");

    const plural = renderDirtyHtml(2);
    expect(plural).toContain("Uncommitted changes: 2 files");
    expect(plural).not.toContain("{count");
  });
});
