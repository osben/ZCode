// @vitest-environment jsdom
//
// Pure helper tests for the Command Center worktree flow, plus one rendered-dialog
// regression test for BUG-GWT-007 (jsdom needed for the dialog block below).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { GitWorktreeEntry } from "@zcode/shared";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import type { QuickPickCommand } from "@/quickpick/quickPickCommands.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildWorktreeTaskProjects,
  composeBranchName,
  computeWorktreeTargetPath,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  deriveWorktreeFormValues,
  findWorktreeForBranch,
  getWorkspaceIdentityKey,
  isValidCustomWorktreeLocationPath,
  NEW_TASK_PROJECT_PAGE_ID,
  NEW_TASK_SETUP_PAGE_ID,
  NEW_TASK_WORKTREE_COMMAND_ID,
  resolveDefaultBaseBranch,
  resolveWorktreeIssueMessageId,
  resolveWorktreeLocation,
  sanitizeWorktreePathSegment,
  tildifyAppWorktreesPath,
  validateNewWorktreeBranchName,
  type WorktreeTaskProjectTab,
} from "@/command-center/worktreeTaskFlow.js";

function localTab(overrides: Partial<WorktreeTaskProjectTab>): WorktreeTaskProjectTab {
  return { workspacePath: "/dev/project", ...overrides };
}

describe("getWorkspaceIdentityKey", () => {
  it("applies the repo identity rule with trim", () => {
    expect(getWorkspaceIdentityKey({ workspacePath: "/dev/project" })).toBe("/dev/project");
    expect(
      getWorkspaceIdentityKey({ workspacePath: "/dev/project", workspaceIdentity: " id-1 " }),
    ).toBe("id-1");
    expect(
      getWorkspaceIdentityKey({ workspacePath: "/dev/project", workspaceIdentity: "  " }),
    ).toBe("/dev/project");
  });
});

describe("buildWorktreeTaskProjects", () => {
  it("merges open local tabs and not-already-open recent projects, dedup by identity", () => {
    const projects = buildWorktreeTaskProjects({
      tabs: [
        localTab({ workspacePath: "/dev/alpha", label: "alpha" }),
        // Duplicate tabs of the same workspace (same identity key) collapse into one row.
        localTab({ workspacePath: "/dev/alpha", label: "alpha-2" }),
        localTab({ workspacePath: "/dev/beta", label: "beta" }),
        // Tabs with an identity also filter out the matching recent entry by path.
        localTab({ workspacePath: "/dev/gamma", workspaceIdentity: "gamma-id" }),
      ],
      recentProjects: ["/dev/alpha", "/dev/gamma", "  ", "/dev/beta", "/dev/delta"],
      activeWorkspaceKey: "/dev/beta",
    });

    expect(projects).toEqual([
      { workspacePath: "/dev/alpha", label: "alpha", isOpen: true, isActive: false },
      { workspacePath: "/dev/beta", label: "beta", isOpen: true, isActive: true },
      { workspacePath: "/dev/gamma", workspaceIdentity: "gamma-id", isOpen: true, isActive: false },
      { workspacePath: "/dev/delta", isOpen: false, isActive: false },
    ]);
  });

  it("excludes remote and conversation-purpose tabs", () => {
    const projects = buildWorktreeTaskProjects({
      tabs: [
        localTab({ workspacePath: "/dev/remote", remoteSessionId: "session-1" }),
        localTab({ workspacePath: "/dev/remote-target", remoteTarget: { kind: "ssh" } }),
        localTab({ workspacePath: "/dev/conversation", workspacePurpose: "conversation" }),
        localTab({ workspacePath: "/dev/local", workspacePurpose: "project" }),
      ],
      recentProjects: [],
      activeWorkspaceKey: "/dev/local",
    });

    expect(projects.map((project) => project.workspacePath)).toEqual(["/dev/local"]);
  });
});

describe("sanitizeWorktreePathSegment / computeWorktreeTargetPath", () => {
  it("flattens branch slashes into a single directory segment", () => {
    expect(sanitizeWorktreePathSegment("feature/my-task")).toBe("feature-my-task");
    expect(sanitizeWorktreePathSegment(" feature x ")).toBe("feature-x");
    expect(sanitizeWorktreePathSegment("--feat--")).toBe("feat");
  });

  it("uses the sibling convention <parent>/<repo>-worktrees/<branch>", () => {
    expect(computeWorktreeTargetPath("/Users/dev/zcode", "feature/login")).toBe(
      "/Users/dev/zcode-worktrees/feature-login",
    );
    // Without a location the default is sibling; Stage C behavior unchanged (only the directory convention was renamed in Stage F).
    expect(computeWorktreeTargetPath("/Users/dev/zcode", "feature/login", null)).toBe(
      "/Users/dev/zcode-worktrees/feature-login",
    );
  });

  it("keeps windows separators consistent with the project path", () => {
    expect(computeWorktreeTargetPath("C:\\dev\\zcode", "task-1")).toBe(
      "C:\\dev\\zcode-worktrees\\task-1",
    );
  });

  it("returns the container when the branch segment is empty and null without a parent", () => {
    expect(computeWorktreeTargetPath("/Users/dev/zcode", "")).toBe("/Users/dev/zcode-worktrees");
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "", {
        mode: "inside",
        customPath: null,
        appWorktreesDir: null,
      }),
    ).toBe("/Users/dev/zcode/.worktrees");
    expect(computeWorktreeTargetPath("zcode", "task")).toBeNull();
  });

  it("places inside-mode worktrees under <repoRoot>/.worktrees", () => {
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "feature/login", {
        mode: "inside",
        customPath: null,
        appWorktreesDir: null,
      }),
    ).toBe("/Users/dev/zcode/.worktrees/feature-login");
  });

  it("places global-mode worktrees under <appWorktreesDir>/<repoName>/<segment>", () => {
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "feature/login", {
        mode: "global",
        customPath: null,
        appWorktreesDir: "/Users/dev/.zcode/worktrees",
      }),
    ).toBe("/Users/dev/.zcode/worktrees/zcode/feature-login");
    // Empty branch segment → the repository directory itself (for previews).
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "", {
        mode: "global",
        customPath: null,
        appWorktreesDir: "/Users/dev/.zcode/worktrees",
      }),
    ).toBe("/Users/dev/.zcode/worktrees/zcode");
    // Windows separators follow the app directory.
    expect(
      computeWorktreeTargetPath("C:\\dev\\zcode", "task-1", {
        mode: "global",
        customPath: null,
        appWorktreesDir: "C:\\Users\\dev\\.zcode\\worktrees",
      }),
    ).toBe("C:\\Users\\dev\\.zcode\\worktrees\\zcode\\task-1");
  });

  it("treats global mode without an app worktrees directory as an invalid location", () => {
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "task", {
        mode: "global",
        customPath: null,
        appWorktreesDir: null,
      }),
    ).toBeNull();
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "task", {
        mode: "global",
        customPath: null,
        appWorktreesDir: "  ",
      }),
    ).toBeNull();
  });

  it("places custom-mode worktrees as <customPath>/<repoName>-<segment>", () => {
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "feature/login", {
        mode: "custom",
        customPath: "/wt-root",
        appWorktreesDir: null,
      }),
    ).toBe("/wt-root/zcode-feature-login");
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "", {
        mode: "custom",
        customPath: "/wt-root",
        appWorktreesDir: null,
      }),
    ).toBe("/wt-root/zcode");
  });

  it("rejects custom mode with an empty or relative location", () => {
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "task", {
        mode: "custom",
        customPath: "",
        appWorktreesDir: null,
      }),
    ).toBeNull();
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "task", {
        mode: "custom",
        customPath: "wt/x",
        appWorktreesDir: null,
      }),
    ).toBeNull();
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "task", {
        mode: "custom",
        customPath: null,
        appWorktreesDir: null,
      }),
    ).toBeNull();
  });
});

describe("isValidCustomWorktreeLocationPath", () => {
  it("accepts non-empty absolute paths only", () => {
    expect(isValidCustomWorktreeLocationPath("/wt-root")).toBe(true);
    expect(isValidCustomWorktreeLocationPath("C:\\wt-root")).toBe(true);
    expect(isValidCustomWorktreeLocationPath("  ")).toBe(false);
    expect(isValidCustomWorktreeLocationPath("wt-root/x")).toBe(false);
    expect(isValidCustomWorktreeLocationPath(undefined)).toBe(false);
  });
});

describe("tildifyAppWorktreesPath", () => {
  it("replaces the app worktrees prefix with the literal ~/.zcode/worktrees for display", () => {
    expect(
      tildifyAppWorktreesPath(
        "/Users/dev/.zcode/worktrees/zcode/task-1",
        "/Users/dev/.zcode/worktrees",
      ),
    ).toBe("~/.zcode/worktrees/zcode/task-1");
    // The directory path itself is replaced too (trailing slashes normalized).
    expect(
      tildifyAppWorktreesPath("/Users/dev/.zcode/worktrees", "/Users/dev/.zcode/worktrees/"),
    ).toBe("~/.zcode/worktrees");
  });

  it("returns paths outside the directory unchanged", () => {
    expect(
      tildifyAppWorktreesPath("/Users/dev/zcode-worktrees/task-1", "/Users/dev/.zcode/worktrees"),
    ).toBe("/Users/dev/zcode-worktrees/task-1");
    // Paths with a similar prefix that do not end in a directory separator are unaffected.
    expect(
      tildifyAppWorktreesPath("/Users/dev/.zcode/worktrees-other/x", "/Users/dev/.zcode/worktrees"),
    ).toBe("/Users/dev/.zcode/worktrees-other/x");
  });
});

describe("resolveWorktreeLocation", () => {
  it("resolves the sibling defaults when nothing is configured", () => {
    expect(resolveWorktreeLocation(null, null, "/dev/alpha")).toEqual({
      mode: "sibling",
      customPath: null,
      appWorktreesDir: null,
      prefix: DEFAULT_WORKTREE_BRANCH_PREFIX,
      baseBranchDefault: null,
      hasProjectOverride: false,
    });
  });

  it("passes the app worktrees directory through trimmed (Stage F global mode)", () => {
    expect(
      resolveWorktreeLocation({ worktreeLocationMode: "global" }, null, "/dev/alpha", " /wt/dir "),
    ).toMatchObject({ mode: "global", appWorktreesDir: "/wt/dir" });
    // Missing directory (non-desktop / not loaded) stays null; global mode behaves as an invalid location.
    expect(
      resolveWorktreeLocation({ worktreeLocationMode: "global" }, null, "/dev/alpha"),
    ).toMatchObject({ appWorktreesDir: null });
  });

  it("lets the project prefix override the global prefix and fall back per-field (WTS-02)", () => {
    const settings = { worktreeBranchPrefix: "global/", worktreeLocationMode: "custom" as const };
    expect(
      resolveWorktreeLocation(settings, { "/dev/alpha": { branchPrefix: "alpha/" } }, "/dev/alpha"),
    ).toMatchObject({
      mode: "custom",
      prefix: "alpha/",
      baseBranchDefault: null,
      hasProjectOverride: true,
    });
    // The override only overrides the prefix; baseBranchDefault defaults separately.
    expect(
      resolveWorktreeLocation(
        settings,
        { "/dev/alpha": { defaultBaseBranch: "dev" } },
        "/dev/alpha",
      ),
    ).toMatchObject({ prefix: "global/", baseBranchDefault: "dev" });
    // Other projects are unaffected.
    expect(
      resolveWorktreeLocation(settings, { "/dev/alpha": { branchPrefix: "alpha/" } }, "/dev/beta"),
    ).toMatchObject({ prefix: "global/", baseBranchDefault: null, hasProjectOverride: false });
  });

  it("treats a deleted override entry as inheriting the global values (reset semantics)", () => {
    const settings = { worktreeBranchPrefix: "global/" };
    const withOverride = resolveWorktreeLocation(
      settings,
      { "/dev/alpha": { branchPrefix: "alpha/" } },
      "/dev/alpha",
    );
    // After "Reset to global" deletes the entry it is identical to never having been configured.
    const afterReset = resolveWorktreeLocation(settings, {}, "/dev/alpha");
    expect(afterReset).toEqual(resolveWorktreeLocation(settings, undefined, "/dev/alpha"));
    expect(afterReset.prefix).toBe("global/");
    expect(afterReset.hasProjectOverride).toBe(false);
    expect(withOverride.prefix).toBe("alpha/");
  });

  it("exposes customPath only for custom mode, trimmed", () => {
    expect(
      resolveWorktreeLocation(
        { worktreeLocationMode: "custom", worktreeCustomLocationPath: " /wt-root " },
        null,
        "/dev/alpha",
      ),
    ).toMatchObject({ mode: "custom", customPath: "/wt-root" });
    expect(
      resolveWorktreeLocation(
        { worktreeLocationMode: "sibling", worktreeCustomLocationPath: "/wt-root" },
        null,
        "/dev/alpha",
      ),
    ).toMatchObject({ mode: "sibling", customPath: null });
  });
});

describe("composeBranchName", () => {
  it("applies the prefix only when the typed name does not already start with it", () => {
    expect(composeBranchName("dev/", "task-9")).toBe("dev/task-9");
    expect(composeBranchName("dev/", "dev/task-9")).toBe("dev/task-9");
    expect(composeBranchName("", "task-9")).toBe("task-9");
    expect(composeBranchName(null, "task-9")).toBe("task-9");
  });

  it("keeps an empty typed name empty so emptiness validation keeps working", () => {
    expect(composeBranchName("dev/", "")).toBe("");
    expect(composeBranchName("dev/", "   ")).toBe("");
  });
});

describe("validateNewWorktreeBranchName", () => {
  it("accepts regular names including slashed ones", () => {
    expect(validateNewWorktreeBranchName("task-1", [])).toBeNull();
    expect(validateNewWorktreeBranchName("feature/login", [])).toBeNull();
  });

  it("rejects check-ref-format basics", () => {
    for (const name of [
      "",
      "-lead",
      ".lead",
      "has space",
      "a..b",
      "a//b",
      "tail/",
      "tail.",
      "tail.lock",
      "a/.b",
      "bad~char",
    ]) {
      expect(validateNewWorktreeBranchName(name, []), name).toBe("invalid-branch-name");
    }
  });

  it("reports existing branches as branch-already-exists", () => {
    expect(validateNewWorktreeBranchName("main", ["main", "dev"])).toBe("branch-already-exists");
    expect(validateNewWorktreeBranchName("fresh", ["main"])).toBeNull();
  });
});

describe("resolveDefaultBaseBranch", () => {
  it("prefers the current branch on branch HEAD, else the first listed branch", () => {
    expect(
      resolveDefaultBaseBranch({
        headRefType: "branch",
        currentBranchName: "main",
        branches: [{ name: "dev" }, { name: "main" }],
      }),
    ).toBe("main");
    expect(
      resolveDefaultBaseBranch({
        headRefType: "detached",
        currentBranchName: null,
        branches: [{ name: "dev" }],
      }),
    ).toBe("dev");
    expect(
      resolveDefaultBaseBranch({ headRefType: "detached", currentBranchName: null, branches: [] }),
    ).toBe("");
  });

  it("prefers the project override's default base branch only when present in the loaded list", () => {
    const branchesResult = {
      headRefType: "branch" as const,
      currentBranchName: "main",
      branches: [{ name: "main" }, { name: "dev" }],
    };
    expect(resolveDefaultBaseBranch(branchesResult, "dev")).toBe("dev");
    // An override branch that is not in the list cannot become the default.
    expect(resolveDefaultBaseBranch(branchesResult, "missing")).toBe("main");
    expect(resolveDefaultBaseBranch(branchesResult, "  ")).toBe("main");
  });
});

describe("findWorktreeForBranch", () => {
  it("finds the entry whose branch matches", () => {
    const worktrees: GitWorktreeEntry[] = [
      {
        path: "/dev/repo",
        headCommitHash: "a",
        branchName: "main",
        isMain: true,
        isBare: false,
        isDetached: false,
        isCurrent: true,
      },
      {
        path: "/dev/repo-worktrees/task-1",
        headCommitHash: "b",
        branchName: "task-1",
        isMain: false,
        isBare: false,
        isDetached: false,
        isCurrent: false,
      },
    ];

    expect(findWorktreeForBranch(worktrees, "task-1")?.path).toBe("/dev/repo-worktrees/task-1");
    expect(findWorktreeForBranch(worktrees, "missing")).toBeNull();
  });
});

describe("resolveWorktreeIssueMessageId", () => {
  it("maps contract codes to inline message ids and falls back to unknown", () => {
    expect(resolveWorktreeIssueMessageId("branch-in-other-worktree")).toBe(
      "commandCenter.worktree.error.branch-in-other-worktree",
    );
    expect(resolveWorktreeIssueMessageId("target-path-exists")).toBe(
      "commandCenter.worktree.error.target-path-exists",
    );
    expect(resolveWorktreeIssueMessageId("not-a-repository")).toBe(
      "commandCenter.worktree.error.not-a-repository",
    );
    expect(resolveWorktreeIssueMessageId("unknown")).toBe("commandCenter.worktree.error.unknown");
  });
});

describe("page id constants", () => {
  it("keeps the worktree flow page ids stable", () => {
    expect(NEW_TASK_WORKTREE_COMMAND_ID).toBe("new-task-worktree");
    expect(NEW_TASK_PROJECT_PAGE_ID).toBe("new-task-project");
    expect(NEW_TASK_SETUP_PAGE_ID).toBe("new-task-setup");
  });
});

describe("deriveWorktreeFormValues existing-branch contract (2026-10-13)", () => {
  const branchesResult = {
    headRefType: "branch" as const,
    currentBranchName: "main",
    branches: [{ name: "main" }, { name: "dev" }],
  };

  function derive(branchName: string) {
    return deriveWorktreeFormValues({
      projectPath: "/dev/project",
      branchName,
      branchesResult,
      // Prefix-independent contract check: the default zcode/ prefix is covered by the
      // resolveWorktreeLocation default test above.
      effectiveLocation: {
        ...resolveWorktreeLocation(null, null, "/dev/project"),
        prefix: "",
      },
      isWorktreeDestination: true,
    });
  }

  it("reports an existing branch as an offer instead of a blocking issue", () => {
    const derived = derive("dev");
    expect(derived.existingBranchName).toBe("dev");
    expect(derived.branchNameIssue).toBeNull();
  });

  it("keeps format problems blocking and does not report them as existing", () => {
    const derived = derive("bad..name");
    expect(derived.existingBranchName).toBeNull();
    expect(derived.branchNameIssue).toBe("invalid-branch-name");
  });

  it("reports nothing for a fresh free branch name", () => {
    const derived = derive("fresh-task");
    expect(derived.existingBranchName).toBeNull();
    expect(derived.branchNameIssue).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// BUG-GWT-007 (docs/testing/git-worktree-qa/bugs/BUG-GWT-007.md, case E4):
// the setup page's existing-branch offer must not silently open a stale
// registered worktree (git record present, directory deleted). Rendered-dialog
// test with a mocked git RPC surface (self-contained; no real git, no sleeps).
// The Command component is mocked following commandCenterWorktreeDialog.test.ts
// (cmdk Input stays real).
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/command.js", async () => {
  const { Command } = await vi.importActual<typeof import("cmdk")>("cmdk");
  const fake = ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children);

  return {
    Command,
    CommandDialog: fake,
    CommandEmpty: fake,
    CommandGroup: fake,
    CommandItem: ({
      children,
      onSelect,
      value,
      ...props
    }: {
      children: ReactNode;
      onSelect?: () => void;
      value?: string;
    }) =>
      createElement(
        "div",
        { ...props, "data-item-value": value ?? "", onClick: onSelect },
        children,
      ),
    CommandList: fake,
    CommandShortcut: ({ children, ...props }: { children: ReactNode }) =>
      createElement("span", props, children),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => ({
    items: [],
    loading: false,
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    fileService: {
      listWorkspaceFiles: vi.fn(async () => []),
    },
  }),
}));

const staleOfferGitService = {
  createWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  resolveWorktreePathIdentities: vi.fn(async ({ paths }: { paths: string[] }) => paths),
  getLocalBranches: vi.fn(),
  getWorkspaceRepositoryInfo: vi.fn(),
  verifyWorktreeUsable: vi.fn(),
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  // The worktree flow targets local project paths: base (local Host) git service only.
  useBaseWorkspaceServices: () => ({ gitService: staleOfferGitService }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { recentProjects: ["/dev/recent-project"] },
    loading: false,
    error: null,
  }),
}));

vi.mock("@/workspace-file-search/fetchWorkspaceFileEntries.js", () => ({
  fetchWorkspaceFileEntriesPacked: vi.fn(async () => ""),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

const STALE_OFFER_COMMAND: QuickPickCommand = {
  id: "new-task-worktree",
  sectionId: "suggested",
  titleId: "quickPick.command.newTaskWorktree",
  icon: "worktree",
  keywords: ["worktree"],
  page: {
    id: "new-task-project",
    placeholderId: "commandCenter.placeholder.newTaskProject",
  },
};

const STALE_OFFER_TABS: WorkspaceTabState[] = [
  {
    id: "tab-alpha" as WorkspaceTabState["id"],
    kind: "workspace",
    label: "alpha",
    workspacePath: "/dev/alpha",
    workspaceIdentity: "alpha-id",
  },
];

function getStaleOfferRow(container: HTMLElement, value: string) {
  const row = container.querySelector(`[data-item-value^="${value}"]`);
  expect(row, `row for ${value}`).not.toBeNull();
  return row as HTMLElement;
}

describe("BUG-GWT-007 existing-branch offer vs stale registered worktree", () => {
  const STALE_WORKTREE_PATH = "/dev/alpha-worktrees/stale";

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // BUG-GWT-007: marked it.fails while the bug is open; remove the marker when fixed
  // (the test then goes green and this suite reports the change).
  it("BUG-GWT-007: opening a worktree whose registered directory is missing must be blocked or surface an error, not open silently", async () => {
    staleOfferGitService.getWorkspaceRepositoryInfo.mockResolvedValue({
      workspacePath: "/dev/alpha",
      kind: "main-tree",
      isGitAvailable: true,
    });
    staleOfferGitService.getLocalBranches.mockResolvedValue({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [
        {
          name: "main",
          isCurrent: true,
          upstreamName: null,
          commitHash: "a",
          commitTimestampMs: 1,
        },
        {
          name: "zcode/stale",
          isCurrent: false,
          upstreamName: null,
          commitHash: "b",
          commitTimestampMs: 1,
        },
      ],
    });
    // `git worktree list` keeps the stale registration (prunable record) even though
    // the directory was removed; the real-directory probe reports it missing.
    staleOfferGitService.listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [
        {
          path: "/dev/alpha",
          headCommitHash: "a",
          branchName: "main",
          isMain: true,
          isBare: false,
          isDetached: false,
          isCurrent: true,
        },
        {
          path: STALE_WORKTREE_PATH,
          headCommitHash: "b",
          branchName: "zcode/stale",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    staleOfferGitService.verifyWorktreeUsable.mockResolvedValue({
      ok: false,
      reason: "missing-directory",
    });

    const onCreateTaskInWorkspace = vi.fn();
    const { container } = render(
      createElement(CommandCenterDialog, {
        open: true,
        commands: [STALE_OFFER_COMMAND],
        workspaceAbsPath: "/dev/alpha",
        workspaceIdentity: "alpha-id",
        workspaceTabs: STALE_OFFER_TABS,
        onOpenChange: vi.fn(),
        onSelectTask: vi.fn(),
        onCreateTaskInWorkspace,
        onOpenCodeViewer: vi.fn(),
      }),
    );

    // Command selection pushes the project page, then picking alpha pushes the setup page.
    fireEvent.click(getStaleOfferRow(container, "quickPick.command.newTaskWorktree"));
    fireEvent.click(getStaleOfferRow(container, "alpha /dev/alpha"));
    fireEvent.change(await screen.findByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "stale" },
    });

    // The composed name zcode/stale matches the existing branch: the offer appears.
    await waitFor(() => {
      expect(screen.getByText("commandCenter.worktree.existingBranchHint")).toBeTruthy();
    });
    const openButton = screen.queryByRole("button", {
      name: "commandCenter.worktree.openExisting",
    }) as HTMLButtonElement | null;
    if (openButton && !openButton.disabled) {
      fireEvent.click(openButton);
    }
    // Flush the click's async open contract (microtasks only; no timer sleeps).
    await act(async () => {});

    const ghostOpenCall = onCreateTaskInWorkspace.mock.calls.some(
      (call) => call[0] === STALE_WORKTREE_PATH,
    );
    const inlineErrorShown = screen.queryAllByRole("alert").length > 0;
    // Blocked (no open call for the missing directory) or accompanied by a visible error.
    expect(ghostOpenCall && !inlineErrorShown).toBe(false);
  });
});
