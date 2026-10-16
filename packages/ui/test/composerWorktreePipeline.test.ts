// Worktree setup pipeline store + runner tests (specs/composer-worktree-setup-steps.md):
// state machine transitions (consume-once, withdraw/orphan), runner idempotency and outcome
// mapping, and stale-creating reconcile.
// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult } from "@zcode/shared";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  isComposerWorktreePipelineInFlight,
  beginWorktreePipelineCreation,
  reconcileCreatingComposerWorktreePipeline,
  retryComposerWorktreePipeline,
  restoreComposerWorktreePipelineFromPreparation,
  startComposerWorktreePipeline,
} from "@/v4/composer/composerWorktreePipeline.js";

const createWorktree = vi.fn();
const listWorktrees = vi.fn();
const gitService = { createWorktree, listWorktrees };

const WORKSPACE_KEY = "/dev/alpha";
const PARAMS = {
  workspacePath: WORKSPACE_KEY,
  branchName: "zcode/sleepy-capybara",
  targetPath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
  baseBranch: "main",
  baseFromHeadDefault: false,
};

function seedCreating(overrides: Record<string, unknown> = {}) {
  useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
    status: "creating",
    params: PARAMS,
    createdAt: 1,
    ...overrides,
  });
}

function currentPipeline(sessionId?: string) {
  return selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    WORKSPACE_KEY,
    sessionId,
  );
}

beforeEach(() => {
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("composerWorktreePipelineStore state machine", () => {
  it("keeps the prepared session identity through setup and admission", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ sessionId: "session-prepared-1" });
    expect(currentPipeline()?.sessionId).toBe("session-prepared-1");

    store.markReady(WORKSPACE_KEY, PARAMS.targetPath, false);
    expect(currentPipeline()?.sessionId).toBe("session-prepared-1");

    store.consume(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      status: "consumed",
      sessionId: "session-prepared-1",
    });
  });

  it("ignores a completion from an earlier retry attempt for the same session", () => {
    const store = useComposerWorktreePipelineStore.getState();
    const firstAttempt = store.startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-retry",
      params: PARAMS,
      createdAt: 1,
    });
    const currentAttempt = useComposerWorktreePipelineStore
      .getState()
      .startPipeline(WORKSPACE_KEY, {
        status: "creating",
        sessionId: "session-retry",
        params: PARAMS,
        createdAt: 2,
      });

    store.markReady(WORKSPACE_KEY, "/dev/stale-worktree", false, "session-retry", firstAttempt);
    expect(currentPipeline("session-retry")).toMatchObject({
      status: "creating",
      attemptId: currentAttempt,
    });
  });

  it("walks creating → ready → consumed with consume-once semantics", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ queuedPromptPreview: "hello" });
    store.markReady(WORKSPACE_KEY, "/dev/alpha-worktrees/zcode-sleepy-capybara", false);
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      queuedPromptPreview: "hello",
    });

    store.consume(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      status: "consumed",
      queuedPromptPreview: undefined,
    });
  });

  it("creating → failed → retry marks creating again with the frozen params", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({
      sessionId: "session-prepared-1",
      queuedPromptPreview: "frozen input",
    });
    store.markFailed(WORKSPACE_KEY, "boom");
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "boom",
    });

    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    return retryComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      formatMessage: (id: string) => id,
    }).then((outcome) => {
      expect(outcome).toBe("ready");
      expect(currentPipeline()).toMatchObject({
        status: "ready",
        sessionId: "session-prepared-1",
        queuedPromptPreview: "frozen input",
      });
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: PARAMS.branchName,
          targetPath: PARAMS.targetPath,
        }),
      );
    });
  });

  it("withdraw marks the queued send dropped; the landing result keeps the orphan note", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ queuedPromptPreview: "hello" });
    store.withdraw(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      orphaned: true,
      queuedPromptPreview: undefined,
    });

    store.markReady(WORKSPACE_KEY, "/dev/alpha-worktrees/zcode-sleepy-capybara", false);
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      orphaned: true,
    });
  });

  it("markValidationFailed writes a params-less failed entry (no Retry surface)", () => {
    useComposerWorktreePipelineStore.getState().markValidationFailed(WORKSPACE_KEY, "bad path");
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "bad path",
    });
    expect(currentPipeline()?.params).toBeUndefined();
  });
});

describe("startComposerWorktreePipeline runner", () => {
  it("restores a Host preparation marker as a retryable session-scoped pipeline", () => {
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "failed",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        baseBranch: "main",
        failureMessage: "Git interrupted",
      },
    });

    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, baseFromHeadDefault: false },
      failureMessage: "Git interrupted",
    });
  });

  it("keeps concurrent session results isolated when an older preparation is restored", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-b",
      params: PARAMS,
      createdAt: 2,
    });
    const runningB = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-b",
      params: PARAMS,
      formatMessage: (id: string) => id,
    });

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-a",
      preparation: {
        status: "failed",
        branchName: "zcode/older-session",
        targetPath: "/dev/alpha-worktrees/zcode-older-session",
        failureMessage: "previous attempt failed",
      },
    });
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await expect(runningB).resolves.toBe("ready");

    expect(currentPipeline("session-a")).toMatchObject({
      status: "failed",
      params: { branchName: "zcode/older-session" },
    });
    expect(currentPipeline("session-b")).toMatchObject({
      status: "ready",
      worktreePath: PARAMS.targetPath,
      params: { branchName: PARAMS.branchName },
    });
    expect(currentPipeline()).toMatchObject({ sessionId: "session-b", status: "ready" });
  });

  it("waits for Host identity before starting Git and retains that ID in the pipeline", async () => {
    let resolvePreparation: (sessionId: string) => void = () => {};
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const begin = beginWorktreePipelineCreation({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: {
        mode: "sibling",
        customPath: null,
        appWorktreesDir: null,
        prefix: "zcode/",
        baseBranchDefault: null,
        hasProjectOverride: false,
      },
      branchName: PARAMS.branchName,
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "frozen input",
      prepareSession: () => new Promise((resolve) => (resolvePreparation = resolve)),
      formatMessage: (id: string) => id,
    });

    await Promise.resolve();
    expect(createWorktree).not.toHaveBeenCalled();
    resolvePreparation("session-prepared-1");
    await expect(begin).resolves.toEqual({
      ok: true,
      sessionId: "session-prepared-1",
    });
    await expect(
      beginWorktreePipelineCreation({
        gitService,
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        effectiveLocation: {
          mode: "sibling",
          customPath: null,
          appWorktreesDir: null,
          prefix: "zcode/",
          baseBranchDefault: null,
          hasProjectOverride: false,
        },
        branchName: "zcode/another-branch",
        baseFromHeadDefault: true,
        queuedPromptPreview: "second input",
        prepareSession: vi.fn(),
        formatMessage: (id: string) => id,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "session-prepared-1" });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(currentPipeline()).toMatchObject({
      status: "creating",
      sessionId: "session-prepared-1",
      queuedPromptPreview: "frozen input",
    });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await vi.waitFor(() => expect(currentPipeline()?.status).toBe("ready"));
  });

  it("joins concurrent session reservations for the same workspace", async () => {
    let resolvePreparation: (sessionId: string) => void = () => {};
    const prepareSession = vi.fn(
      () => new Promise<string>((resolve) => (resolvePreparation = resolve)),
    );
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const input = {
      gitService,
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: {
        mode: "sibling" as const,
        customPath: null,
        appWorktreesDir: null,
        prefix: "zcode/",
        baseBranchDefault: null,
        hasProjectOverride: false,
      },
      branchName: PARAMS.branchName,
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "frozen input",
      prepareSession,
      formatMessage: (id: string) => id,
    };
    const first = beginWorktreePipelineCreation(input);
    const second = beginWorktreePipelineCreation(input);

    expect(second).toBe(first);
    expect(prepareSession).toHaveBeenCalledTimes(1);
    resolvePreparation("session-prepared-1");
    await expect(second).resolves.toEqual({
      ok: true,
      sessionId: "session-prepared-1",
    });
    await vi.waitFor(() => expect(currentPipeline()?.status).toBe("ready"));
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("reuses the in-flight promise for the same workspace (idempotent double-send)", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    seedCreating();
    const first = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    const second = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    expect(second).toBe(first);
    expect(isComposerWorktreePipelineInFlight(WORKSPACE_KEY)).toBe(true);
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await expect(first).resolves.toBe("ready");
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(isComposerWorktreePipelineInFlight(WORKSPACE_KEY)).toBe(false);
  });

  it("maps a thrown request to failed without rejecting", async () => {
    createWorktree.mockRejectedValue(new Error("rpc down"));
    seedCreating();
    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    expect(outcome).toBe("failed");
    expect(currentPipeline()?.status).toBe("failed");
  });
});

describe("reconcileCreatingComposerWorktreePipeline", () => {
  it("settles a stale creating entry via the worktree list", async () => {
    seedCreating();
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [
        {
          path: "/dev/alpha-worktrees/zcode-sleepy-capybara",
          headCommitHash: "c",
          branchName: "zcode/sleepy-capybara",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
  });

  it("marks failed when no worktree exists for the branch", async () => {
    seedCreating();
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [],
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "worktreeSetup.reconcile.staleCreating",
    });
  });

  it("marks failed when Git worktree state cannot be read", async () => {
    seedCreating({ sessionId: "session-prepared-1" });
    listWorktrees.mockRejectedValue(new Error("Git unavailable"));

    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });

    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      failureMessage: "worktreeSetup.reconcile.staleCreating",
    });
  });

  it("does not touch a live in-flight entry", async () => {
    seedCreating();
    // The runner must settle before the test ends, or its in-flight promise leaks into the next
    // test through the module-level map (same workspace key).
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const runner = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()?.status).toBe("creating");
    expect(listWorktrees).not.toHaveBeenCalled();
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await runner;
  });
});
