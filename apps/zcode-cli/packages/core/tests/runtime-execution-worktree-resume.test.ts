import { describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

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

describe("execution worktree sessions", () => {
  it("cold resume restores the execution worktree as working directory", async () => {
    const session = buildSession({
      directory: "/workspace/project",
      path: "/workspace/project",
      executionDirectory: "/workspace/worktrees/zcode-sleepy-capybara",
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
    expect((runtime as unknown as { workingDirectory: string }).workingDirectory).toBe(
      "/workspace/worktrees/zcode-sleepy-capybara",
    );
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
