import { describe, expect, it } from "vitest";
import type { GitWorktreeEntry } from "@zcode/shared";
import {
  buildWorktreeTaskProjects,
  composeBranchName,
  computeWorktreeTargetPath,
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
        // 同一 workspace 的重复标签（相同 identity key）只保留一行。
        localTab({ workspacePath: "/dev/alpha", label: "alpha-2" }),
        localTab({ workspacePath: "/dev/beta", label: "beta" }),
        // 带 identity 的 tab 也会通过路径过滤掉对应的 recent 记录。
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
    // 不传 location 时默认 sibling，Stage C 行为不变（仅目录约定 Stage F 更名）。
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
    // 空分支段 → 仓库目录本身（预览用）。
    expect(
      computeWorktreeTargetPath("/Users/dev/zcode", "", {
        mode: "global",
        customPath: null,
        appWorktreesDir: "/Users/dev/.zcode/worktrees",
      }),
    ).toBe("/Users/dev/.zcode/worktrees/zcode");
    // Windows 分隔符跟随 app 目录。
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
    // 目录本身的路径同样替换（尾部斜杠被规范化）。
    expect(
      tildifyAppWorktreesPath("/Users/dev/.zcode/worktrees", "/Users/dev/.zcode/worktrees/"),
    ).toBe("~/.zcode/worktrees");
  });

  it("returns paths outside the directory unchanged", () => {
    expect(
      tildifyAppWorktreesPath("/Users/dev/zcode-worktrees/task-1", "/Users/dev/.zcode/worktrees"),
    ).toBe("/Users/dev/zcode-worktrees/task-1");
    // 相似前缀但不以目录分隔符结尾的路径不受影响。
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
      prefix: "",
      baseBranchDefault: null,
      hasProjectOverride: false,
    });
  });

  it("passes the app worktrees directory through trimmed (Stage F global mode)", () => {
    expect(
      resolveWorktreeLocation({ worktreeLocationMode: "global" }, null, "/dev/alpha", " /wt/dir "),
    ).toMatchObject({ mode: "global", appWorktreesDir: "/wt/dir" });
    // 目录缺失（非 desktop / 未加载）时保持 null，global 模式按无效位置处理。
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
    // override 只覆盖 prefix，baseBranchDefault 单独缺省。
    expect(
      resolveWorktreeLocation(
        settings,
        { "/dev/alpha": { defaultBaseBranch: "dev" } },
        "/dev/alpha",
      ),
    ).toMatchObject({ prefix: "global/", baseBranchDefault: "dev" });
    // 其它项目不受影响。
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
    // “Reset to global” 删除条目后与从未配置完全一致。
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
    // 不在列表中的 override 分支不能作为默认值。
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
