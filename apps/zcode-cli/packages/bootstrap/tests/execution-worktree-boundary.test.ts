// Execution-worktree boundary behavior (spec: execution-worktree-missing-handling.md §1-2):
// create rejects a dead worktree path before any runtime/record is created; resume keeps the
// fact but marks it missing so the runtime falls back to the parent workspace.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectId, createSessionId, type SessionInfo } from "@zcode/contracts";
import {
  activateSessionForResume,
  createSessionRecordForV4,
} from "../src/zcode-protocol/server-operations.js";
import { buildWorkspaceRef } from "../src/zcode-protocol/workspace.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SENTINEL_STOP = "stop: app creation reached";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-worktree-boundary-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface CapturedAppOptions {
  workingDirectory?: string;
  executionWorktree?: { path: string; branchName?: string; missing?: boolean };
}

/**
 * Minimal context whose createZCodeApp stub records the runtimeConfig it was about to receive and
 * throws a sentinel, so tests observe the boundary decision without materializing a real app.
 */
function contextWithCapturingApp(captured: CapturedAppOptions[]): ZCodeProtocolAgentServerContext {
  return {
    deps: {
      // The stub app throws a sentinel before consuming these; they only need to exist so
      // createRecord reaches the createZCodeApp call that carries the runtimeConfig under test.
      createSessionEventStore: () => ({}) as never,
      createZCodeApp: async (options: { runtimeConfig?: CapturedAppOptions }) => {
        captured.push({
          workingDirectory: options.runtimeConfig?.workingDirectory,
          executionWorktree: options.runtimeConfig?.executionWorktree,
        });
        throw new Error(SENTINEL_STOP);
      },
    },
    sessions: new Map(),
    appRuntimePreferences: {},
    requestClient: async () => ({ nativeSearchEnhancementsEnabled: false }),
    v4Interactions: {
      initializeAskUserQuestionAutoResolutionEnabled: async () => {},
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

function persistedSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: createSessionId("worktree-boundary"),
    projectID: createProjectId("worktree-boundary"),
    directory: "/workspace/project",
    slug: "worktree-boundary",
    title: "worktree session",
    version: "test",
    taskType: "interactive",
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

describe("execution worktree boundary health check", () => {
  it("create rejects a nonexistent worktree path before any record or runtime is created", async () => {
    const captured: CapturedAppOptions[] = [];
    const context = contextWithCapturingApp(captured);
    const missingPath = join(tmpdir(), "zcode-worktree-boundary-does-not-exist");

    await expect(
      createSessionRecordForV4(context, {
        workspace: buildWorkspaceRef({ workspacePath: "/workspace/project" }),
        executionWorktree: { path: missingPath, branchName: "zcode/sleepy-capybara" },
      }),
    ).rejects.toThrow(
      `Execution worktree path does not exist or is not a directory: ${missingPath}`,
    );
    // Scenario 2: no app was created and no session row was registered.
    expect(captured).toHaveLength(0);
    expect(context.sessions.size).toBe(0);
  });

  it("create with an existing worktree directory passes the fact through unmarked", async () => {
    const captured: CapturedAppOptions[] = [];
    const context = contextWithCapturingApp(captured);
    const worktreePath = createTempDir();

    await expect(
      createSessionRecordForV4(context, {
        workspace: buildWorkspaceRef({ workspacePath: "/workspace/project" }),
        executionWorktree: { path: worktreePath, branchName: "zcode/sleepy-capybara" },
      }),
    ).rejects.toThrow(SENTINEL_STOP);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.executionWorktree).toEqual({
      path: worktreePath,
      branchName: "zcode/sleepy-capybara",
    });
  });

  it("resume keeps the worktree fact but marks it missing when the directory is gone", async () => {
    const captured: CapturedAppOptions[] = [];
    const deletedWorktreePath = join(tmpdir(), "zcode-worktree-boundary-deleted");
    const context = contextWithCapturingApp(captured);
    const session = persistedSession({
      directory: "/workspace/project",
      path: "/workspace/project",
      executionDirectory: deletedWorktreePath,
      executionBranch: "zcode/sleepy-capybara",
    });
    context.deps.sessionStore = {
      getSession: async () => session,
      messages: async () => [],
    };

    await expect(activateSessionForResume(context, { sessionId: session.id })).rejects.toThrow(
      SENTINEL_STOP,
    );
    // The runtimeConfig handed toward app creation carries the fact marked missing and the parent
    // workspace as workingDirectory — createZCodeApp therefore never adopts the dead path.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.executionWorktree).toEqual({
      path: deletedWorktreePath,
      branchName: "zcode/sleepy-capybara",
      missing: true,
    });
    expect(captured[0]?.workingDirectory).toBe("/workspace/project");
  });
});
