// Branch-switch guard + draft branch intent tests (specs/composer-branch-switcher-semantics.md):
// pure affected-list computation (phases, worktree exclusion, same-root grouping), intent store
// lifecycle, and a source contract for the composer send-time ordering (guard → switch → create,
// abort preserves the draft).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDraftBranchIntentForSend,
  collectAffectedActiveTasks,
  selectDraftBranchIntent,
  selectWorktreeIntentActive,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import { beginWorktreePipelineCreation } from "@/v4/composer/composerWorktreePipeline.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";

const WORKSPACE_KEY = "/dev/alpha";

function task(overrides: Record<string, unknown>) {
  return {
    taskId: "t1",
    workspacePath: WORKSPACE_KEY,
    title: "Task",
    activity: { phase: "running" },
    ...overrides,
  };
}

describe("collectAffectedActiveTasks (guard list, spec §2)", () => {
  it("lists only prewarming/running tasks of the workspace for a checkout switch", () => {
    const affected = collectAffectedActiveTasks(
      [
        task({ taskId: "run", title: "Running" }),
        task({ taskId: "prewarm", activity: { phase: "prewarming" }, title: "Prewarm" }),
        task({ taskId: "done", activity: { phase: "completedSuccess" } }),
        task({ taskId: "draft", activity: { phase: "draft" } }),
        task({ taskId: "other-ws", workspacePath: "/dev/beta" }),
      ],
      { workspaceKey: WORKSPACE_KEY, scope: "checkout" },
    );
    expect(affected.map((entry) => entry.taskId)).toEqual(["run", "prewarm"]);
  });

  it("excludes worktree-bound sessions from a checkout switch", () => {
    const affected = collectAffectedActiveTasks(
      [
        task({ taskId: "plain" }),
        task({ taskId: "wt", executionWorktree: { path: "/dev/alpha-worktrees/zcode-x" } }),
      ],
      { workspaceKey: WORKSPACE_KEY, scope: "checkout" },
    );
    expect(affected.map((entry) => entry.taskId)).toEqual(["plain"]);
  });

  it("worktree scope lists only tasks bound to that exact worktree", () => {
    const affected = collectAffectedActiveTasks(
      [
        task({ taskId: "plain" }),
        task({ taskId: "wt-a", executionWorktree: { path: "/dev/alpha-worktrees/zcode-a" } }),
        task({ taskId: "wt-b", executionWorktree: { path: "/dev/alpha-worktrees/zcode-b" } }),
      ],
      {
        workspaceKey: WORKSPACE_KEY,
        scope: "worktree",
        worktreePath: "/dev/alpha-worktrees/zcode-a",
      },
    );
    expect(affected.map((entry) => entry.taskId)).toEqual(["wt-a"]);
  });

  it("keys workspaces by identity when present", () => {
    const affected = collectAffectedActiveTasks(
      [task({ workspacePath: "/elsewhere", workspaceIdentity: "remote::/dev/alpha" })],
      { workspaceKey: "remote::/dev/alpha", scope: "checkout" },
    );
    expect(affected).toHaveLength(1);
  });
});

describe("draftBranchIntent store (spec §1)", () => {
  it("sets, selects, and clears the intent; mirrors the worktree-intent flag", () => {
    const store = useDraftBranchIntentStore.getState();
    store.setDraftBranchIntent(WORKSPACE_KEY, "feature/x");
    expect(selectDraftBranchIntent(useDraftBranchIntentStore.getState(), WORKSPACE_KEY)).toBe(
      "feature/x",
    );
    store.setWorktreeIntentActive(WORKSPACE_KEY, true);
    expect(selectWorktreeIntentActive(useDraftBranchIntentStore.getState(), WORKSPACE_KEY)).toBe(
      true,
    );
    store.clearDraftBranchIntent(WORKSPACE_KEY);
    store.setWorktreeIntentActive(WORKSPACE_KEY, false);
    const state = useDraftBranchIntentStore.getState();
    expect(selectDraftBranchIntent(state, WORKSPACE_KEY)).toBeNull();
    expect(selectWorktreeIntentActive(state, WORKSPACE_KEY)).toBe(false);
  });
});

describe("ConversationComposer send-time branch resolution (source contract)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/ui/src/v4/ConversationComposer.tsx"),
    "utf8",
  );

  it("delegates to the resolver before the send dispatch; failures abort without claiming the draft", () => {
    const helperIndex = source.indexOf("await applyDraftBranchIntentForSend({");
    const runSendIndex = source.indexOf(
      "await runSend(executionWorktree, preparedSessionIdForSend);",
    );
    expect(helperIndex).toBeGreaterThan(-1);
    expect(runSendIndex).toBeGreaterThan(helperIndex);
    // Abort paths return before runSend; only "proceed" reaches the dispatch.
    expect(source).toContain('resolution.outcome === "aborted"');
    // The intent applies only in checkout mode (the worktree pipeline owns the branch).
    expect(source).toContain("executionWorktree === undefined &&");
    expect(source).toContain("!queueWorktreeSend &&");
    expect(source).not.toContain("gitService.switchBranch");
  });

  it("clears the intent when a non-empty draft becomes empty", () => {
    expect(source).toContain("draftHadTextRef");
  });
});

describe("applyDraftBranchIntentForSend (no silent git failures)", () => {
  const KEY = "/dev/alpha";
  const getLocalBranches = vi.fn();
  const switchBranch = vi.fn();
  const gitService = { getLocalBranches, switchBranch };

  beforeEach(() => {
    useDraftBranchIntentStore.setState({ intentByWorkspaceKey: {} });
    getLocalBranches.mockReset();
    switchBranch.mockReset();
    getLocalBranches.mockResolvedValue({ currentBranchName: "main" });
  });

  function intent() {
    return selectDraftBranchIntent(useDraftBranchIntentStore.getState(), KEY);
  }

  it("same branch: proceeds with no switch call and clears the intent", async () => {
    useDraftBranchIntentStore.getState().setDraftBranchIntent(KEY, "main");
    const guard = vi.fn(async () => false);
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      guard,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "main",
    });
    expect(outcome).toEqual({ outcome: "proceed" });
    expect(guard).not.toHaveBeenCalled();
    expect(switchBranch).not.toHaveBeenCalled();
    expect(intent()).toBeNull();
  });

  it("different branch, clean switch: proceeds and clears the intent", async () => {
    switchBranch.mockResolvedValue({ ok: true, issues: [] });
    useDraftBranchIntentStore.getState().setDraftBranchIntent(KEY, "feature/x");
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "feature/x",
    });
    expect(outcome).toEqual({ outcome: "proceed" });
    expect(switchBranch).toHaveBeenCalledWith({
      workspacePath: KEY,
      targetBranchName: "feature/x",
    });
    expect(intent()).toBeNull();
  });

  it("guard cancellation: reads current branch but skips switch, intent preserved for a retry", async () => {
    useDraftBranchIntentStore.getState().setDraftBranchIntent(KEY, "feature/x");
    const guard = vi.fn(async () => false);
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      guard,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "feature/x",
    });
    expect(outcome).toEqual({ outcome: "aborted", reason: "guard" });
    expect(getLocalBranches).toHaveBeenCalledWith({ workspacePath: KEY });
    expect(switchBranch).not.toHaveBeenCalled();
    expect(intent()).toBe("feature/x");
  });

  it("rejected switch (dirty tree etc.): aborts with the issue text, intent preserved", async () => {
    switchBranch.mockResolvedValue({
      ok: false,
      issues: [{ code: "tracked-overwrite", message: "Local changes would be overwritten" }],
    });
    useDraftBranchIntentStore.getState().setDraftBranchIntent(KEY, "feature/x");
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "feature/x",
    });
    expect(outcome).toEqual({
      outcome: "aborted",
      reason: "switch-failed",
      message: "Local changes would be overwritten",
    });
    expect(intent()).toBe("feature/x");
  });

  it("thrown switch: aborts with the error, never rejects, intent preserved", async () => {
    switchBranch.mockRejectedValue(new Error("rpc down"));
    useDraftBranchIntentStore.getState().setDraftBranchIntent(KEY, "feature/x");
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "feature/x",
    });
    expect(outcome).toEqual({
      outcome: "aborted",
      reason: "switch-error",
      message: "rpc down",
    });
    expect(intent()).toBe("feature/x");
  });

  it("no guard provided (compact shell): still resolves the switch", async () => {
    switchBranch.mockResolvedValue({ ok: true, issues: [] });
    const outcome = await applyDraftBranchIntentForSend({
      gitService,
      workspaceKey: KEY,
      workspacePath: KEY,
      branchName: "feature/x",
    });
    expect(outcome).toEqual({ outcome: "proceed" });
  });
});

describe("beginWorktreePipelineCreation validation (no silent worktree misfires)", () => {
  const KEY = "/dev/alpha";
  const createWorktree = vi.fn();
  const listWorktrees = vi.fn();
  const gitService = { createWorktree, listWorktrees };
  const formatMessage = (id: string) => id;
  const prepareSession = async () => "session-1";
  const baseInput = {
    gitService,
    workspaceKey: KEY,
    workspacePath: KEY,
    branchName: "zcode/sleepy-capybara",
    queuedPromptPreview: "prompt",
    prepareSession,
    formatMessage,
  };
  const projectLocation = { mode: "project" as const, prefix: "zcode/", baseBranchDefault: null };

  beforeEach(() => {
    useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
    createWorktree.mockReset();
  });

  it("a present-but-invalid custom path fails validation with no git call", async () => {
    const outcome = await beginWorktreePipelineCreation({
      ...baseInput,
      effectiveLocation: {
        mode: "custom",
        prefix: "zcode/",
        baseBranchDefault: null,
        customPath: "not/absolute",
      },
    });
    expect(outcome).toEqual({ ok: false });
    expect(createWorktree).not.toHaveBeenCalled();
    const entry = selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), KEY);
    expect(entry?.status).toBe("failed");
    expect(entry?.failureMessage).toBe("commandCenter.worktree.error.custom-location-invalid");
  });

  it("global mode without a storage dir fails validation with no git call", async () => {
    const outcome = await beginWorktreePipelineCreation({
      ...baseInput,
      effectiveLocation: {
        mode: "global",
        prefix: "zcode/",
        baseBranchDefault: null,
        appWorktreesDir: null,
      },
    });
    expect(outcome).toEqual({ ok: false });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("valid input lands a creating entry and starts the runner (settled)", async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const outcome = await beginWorktreePipelineCreation({
      ...baseInput,
      effectiveLocation: projectLocation,
      baseBranch: "main",
      baseFromHeadDefault: false,
    });
    expect(outcome).toEqual({ ok: true, sessionId: "session-1" });
    const entry = selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), KEY);
    expect(entry).toMatchObject({
      status: "creating",
      params: { branchName: "zcode/sleepy-capybara", baseBranch: "main" },
      queuedPromptPreview: "prompt",
    });
    resolveCreate({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
      issues: [],
    });
    await new Promise((tick) => setTimeout(tick, 0));
    expect(
      selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), KEY)?.status,
    ).toBe("ready");
  });
});
