import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  type Logger,
  type LogContext,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { getMissingExecutionWorktreeToolError } from "../src/runtime/helpers/execution-worktree-guard.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const tempDirs: string[] = [];

function createTempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-worktree-resume-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: createSessionId("execution-worktree"),
    projectID: createProjectId("execution-worktree"),
    directory: "/workspace/project",
    slug: "execution-worktree",
    title: "worktree session",
    version: "test",
    taskType: "interactive",
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function buildStore(session: SessionInfo) {
  return {
    getSession: vi.fn(async () => session),
    messages: vi.fn(async () => []),
    sessionEntries: vi.fn(async () => []),
    readTodos: vi.fn(async () => []),
    readTarget: vi.fn(async () => null),
    saveMessage: vi.fn(async () => {}),
    savePart: vi.fn(async () => {}),
    saveSessionEntry: vi.fn(async () => {}),
    updateSession: vi.fn(async () => session),
    createSession: vi.fn(async () => session),
  } as unknown as SessionStorePort;
}

/** Captures warn calls so the resume fallback's single diagnostic is observable. */
function createWarnCaptureLogger(): {
  logger: Logger;
  warns: Array<{ message: string; context?: LogContext }>;
} {
  const warns: Array<{ message: string; context?: LogContext }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, context) => {
      warns.push({ message, context });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

describe("execution worktree sessions", () => {
  it("blocks workspace tools for a missing worktree but leaves non-workspace tools available", async () => {
    const missingWorktree = { path: "/workspace/project/.worktrees/task", missing: true };
    const isDirectory = vi.fn(async () => false);

    await expect(
      getMissingExecutionWorktreeToolError(missingWorktree, "none", "Read", isDirectory),
    ).resolves.toContain(missingWorktree.path);
    for (const toolName of [
      "CreateWorkflow",
      "AmendWorkflow",
      "FillWorkflowHole",
      "ResumeWorkflowRun",
    ]) {
      await expect(
        getMissingExecutionWorktreeToolError(missingWorktree, "none", toolName, isDirectory),
      ).resolves.toContain(missingWorktree.path);
    }
    await expect(
      getMissingExecutionWorktreeToolError(missingWorktree, "none", "ListModels", isDirectory),
    ).resolves.toBeUndefined();
    await expect(
      getMissingExecutionWorktreeToolError(missingWorktree, "network", "WebSearch", isDirectory),
    ).resolves.toBeUndefined();
    expect(isDirectory).toHaveBeenCalledTimes(5);
  });

  it("clears the missing fact only after a workspace tool confirms the directory was restored", async () => {
    const isDirectory = vi.fn(async () => true);
    const onValidated = vi.fn();

    await expect(
      getMissingExecutionWorktreeToolError(
        { path: "/workspace/project/.worktrees/task", missing: true },
        "workspace",
        "Read",
        isDirectory,
        onValidated,
      ),
    ).resolves.toBeUndefined();
    expect(onValidated).toHaveBeenCalledWith(true);

    onValidated.mockClear();
    await expect(
      getMissingExecutionWorktreeToolError(
        { path: "/workspace/project/.worktrees/task", missing: true },
        "network",
        "WebSearch",
        isDirectory,
        onValidated,
      ),
    ).resolves.toBeUndefined();
    expect(onValidated).not.toHaveBeenCalled();
    expect(isDirectory).toHaveBeenCalledTimes(1);
  });

  it("cold resume restores the execution worktree as working directory", async () => {
    const worktreePath = createTempWorktree();
    const session = buildSession({
      directory: "/workspace/project",
      path: "/workspace/project",
      executionDirectory: worktreePath,
      executionBranch: "zcode/sleepy-capybara",
    });
    const runtime = new AgentRuntime(
      session.id,
      { workingDirectory: session.directory, titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: buildStore(session),
        modelFactory: vi.fn(createTestModelFactory({})),
      },
    );

    await runtime.resumeFromStore();
    const internal = runtime as unknown as {
      workingDirectory: string;
      config: { executionWorktree?: { missing?: boolean } };
    };
    expect(internal.workingDirectory).toBe(worktreePath);
    expect(internal.config.executionWorktree?.missing).toBeUndefined();
  });

  it("ordinary sessions keep resuming in the persisted workspace directory", async () => {
    const session = buildSession({ directory: "/workspace/project" });
    const runtime = new AgentRuntime(
      session.id,
      { workingDirectory: session.directory, titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: buildStore(session),
        modelFactory: vi.fn(createTestModelFactory({})),
      },
    );

    await runtime.resumeFromStore();
    expect((runtime as unknown as { workingDirectory: string }).workingDirectory).toBe(
      "/workspace/project",
    );
  });

  it("cold resume retains the missing worktree as cwd so tools cannot target the parent", async () => {
    // Simulate out-of-band deletion: the persisted path points at a directory that no longer exists.
    const deletedWorktreePath = join(tmpdir(), "zcode-worktree-resume-deleted");
    const session = buildSession({
      directory: "/workspace/project",
      path: "/workspace/project",
      executionDirectory: deletedWorktreePath,
      executionBranch: "zcode/sleepy-capybara",
    });
    const { logger, warns } = createWarnCaptureLogger();
    const runtime = new AgentRuntime(
      session.id,
      { workingDirectory: session.directory, titleGeneration: { enabled: false } },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: buildStore(session),
        modelFactory: vi.fn(createTestModelFactory({})),
        logger,
      },
    );

    await runtime.resumeFromStore();
    const internal = runtime as unknown as {
      workingDirectory: string;
      config: {
        executionWorktree?: {
          path: string;
          branchName?: string;
          missing?: boolean;
          workspacePath?: string;
        };
      };
    };
    // Keep the missing execution path as cwd; the tool executor rejects workspace operations.
    expect(internal.workingDirectory).toBe(deletedWorktreePath);
    // The fact stays visible (marked missing) for the wire meta and the env bullet.
    expect(internal.config.executionWorktree).toEqual({
      path: deletedWorktreePath,
      branchName: "zcode/sleepy-capybara",
      missing: true,
      workspacePath: "/workspace/project",
    });
    // Exactly one diagnostic per resume, with the specified event id.
    const fallbackWarns = warns.filter(
      (entry) => entry.context?.event === "session.resume.execution_worktree_missing",
    );
    expect(fallbackWarns).toHaveLength(1);
    expect(fallbackWarns[0]?.context).toMatchObject({
      module: "core.runtime",
      path: deletedWorktreePath,
    });
  });

  it("persists directory/path as the workspace and the worktree in dedicated columns", async () => {
    const session = buildSession();
    const store = buildStore(session);
    const runtime = new AgentRuntime(
      session.id,
      {
        workingDirectory: "/workspace/worktrees/zcode-sleepy-capybara",
        workspacePath: "/workspace/project",
        executionWorktree: {
          path: "/workspace/worktrees/zcode-sleepy-capybara",
          branchName: "zcode/sleepy-capybara",
        },
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: store,
        modelFactory: vi.fn(createTestModelFactory({})),
      },
    );

    await runtime.ensureSessionPersistedForExternalActivity("first input", {
      traceContext: { traceId: "trace-1" as never },
    });
    const createInput = (store.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(createInput).toMatchObject({
      // Listing identity stays on the parent workspace; the worktree lives in the dedicated columns.
      directory: "/workspace/project",
      path: "/workspace/project",
      executionDirectory: "/workspace/worktrees/zcode-sleepy-capybara",
      executionBranch: "zcode/sleepy-capybara",
    });
  });
});
