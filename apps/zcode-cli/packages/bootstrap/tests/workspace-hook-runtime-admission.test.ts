import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  createDefaultFileWorkspaceHookTrustStore,
  createInMemorySessionEventStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import { createWorkspaceHookTrustRecords } from "@zcode/core";
import { SessionEventType, type ExecutionPort } from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createZCodeApp workspace Hook admission", () => {
  it("首次 activation 等待 Trust store load；pending blocked，exact pretrust 后执行同一 snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-runtime-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "echo trusted-project-hook" }],
              },
            ],
          },
        },
      }),
    );

    const blockedCommands: string[] = [];
    const blockedEvents = createInMemorySessionEventStore();
    const blockedSessionStore = createSqliteSessionStore({
      dbPath: ":memory:",
    });
    const blockedApp = await createZCodeApp({
      env: {},
      eventStore: blockedEvents,
      executionPort: executionPort(blockedCommands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore: blockedSessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await blockedApp.submitPrompt("hello");
      expect(blockedCommands).toEqual([]);
      const events = await blockedEvents.getEvents(blockedApp.sessionId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.HookRunBlocked,
          payload: expect.objectContaining({
            descriptor: expect.objectContaining({ sourceKind: "project" }),
            errorCode: "workspace_hooks_pending_trust",
          }),
        }),
      );
    } finally {
      await blockedApp.close();
      blockedSessionStore.close();
    }

    const configResult = createConfig({
      env: {},
      userConfigPath,
      workingDirectory: workspace,
    });
    const snapshot = configResult.sources.project.workspaceHookSnapshot;
    if (!snapshot) throw new Error("expected workspace Hook snapshot");
    const trustStore = await createDefaultFileWorkspaceHookTrustStore({
      userConfigPath,
    });
    await trustStore.grant(
      createWorkspaceHookTrustRecords({
        snapshot,
        reviewItemIds: snapshot.hooks.map((entry) => entry.reviewItemId),
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
    );

    const trustedCommands: string[] = [];
    const trustedEvents = createInMemorySessionEventStore();
    const trustedSessionStore = createSqliteSessionStore({
      dbPath: ":memory:",
    });
    const trustedApp = await createZCodeApp({
      env: {},
      eventStore: trustedEvents,
      executionPort: executionPort(trustedCommands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore: trustedSessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await trustedApp.submitPrompt("hello");
      expect(trustedCommands).toEqual(["echo trusted-project-hook"]);
      const events = await trustedEvents.getEvents(trustedApp.sessionId);
      expect(
        events.some(
          (event) =>
            event.type === SessionEventType.HookRunStarted &&
            event.payload.descriptor?.sourceKind === "project",
        ),
      ).toBe(true);
    } finally {
      await trustedApp.close();
      trustedSessionStore.close();
    }
  });

  it("feature flag 关闭时即使已有 persistent Trust 也不执行且不发 review", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-rollout-off-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo rollout-off" }] }],
          },
        },
      }),
    );

    const configResult = createConfig({
      env: {},
      userConfigPath,
      workingDirectory: workspace,
    });
    const snapshot = configResult.sources.project.workspaceHookSnapshot;
    if (!snapshot) throw new Error("expected workspace Hook snapshot");
    const trustStore = await createDefaultFileWorkspaceHookTrustStore({
      userConfigPath,
    });
    await trustStore.grant(
      createWorkspaceHookTrustRecords({
        snapshot,
        reviewItemIds: snapshot.hooks.map((entry) => entry.reviewItemId),
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
    );

    const commands: string[] = [];
    const events = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore: events,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: false,
      workspaceHookReviewHost: {
        taskId: "task-rollout-off",
        runId: "run-rollout-off",
        workspaceLabel: "Rollout off",
      },
    });
    try {
      await app.submitPrompt("hello");
      expect(commands).toEqual([]);
      const recorded = await events.getEvents(app.sessionId);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.HookRunBlocked,
          payload: expect.objectContaining({
            errorCode: "workspace_hooks_feature_disabled",
          }),
        }),
      );
      expect(
        recorded.some((event) => event.type === SessionEventType.WorkspaceHookReviewRequested),
      ).toBe(false);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  it("软门禁：activation 跳过 pending hooks，信任选中项后只更新后续准入", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-review-runtime-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo reviewed-once" }] }],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
      workspaceHookReviewHost: {
        taskId: "task-review",
        runId: "run-review",
        workspaceLabel: "Review workspace",
      },
    });
    try {
      // Soft gate: the prompt triggers activation, pending hooks are skipped directly, and the turn runs as usual
      const prompt = app.submitPrompt("hello");
      await prompt;

      // Pending hooks are skipped, no command executed
      expect(commands).toEqual([]);

      // The admission updated event has been emitted (pendingCount > 0)
      const admissionEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookAdmissionUpdated,
      );
      expect(admissionEvent.payload).toMatchObject({ pendingCount: 1 });

      // The user clicks "去审核" (go review) → opens the review flow
      const admissionSnapshot = admissionEvent.payload as {
        bundleDigest: string;
        workspaceIdentity?: string;
      };
      await app.requestWorkspaceHookReview({
        workspaceIdentity: admissionSnapshot.workspaceIdentity!,
        bundleDigest: admissionSnapshot.bundleDigest,
      });

      const requestEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookReviewRequested,
      );
      const request = (requestEvent.payload as { request: any }).request;

      // Persistently trust the selected items; the missed SessionStart is not caught up within the current task.
      await expect(
        app.respondWorkspaceHookReview({
          sessionId: app.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
          decision: {
            action: "trust_selected",
            reviewItemIds: [request.items[0].reviewItemId],
          },
        }),
      ).resolves.toMatchObject({ accepted: true });

      const events = await eventStore.getEvents(app.sessionId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: expect.objectContaining({
            interactionId: request.interactionId,
            state: "resolved",
          }),
        }),
      );
      expect(commands).toEqual([]);
      // Soft gate (D2): after settle, admission updated recomputes pendingCount=0
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.WorkspaceHookAdmissionUpdated,
          payload: expect.objectContaining({ pendingCount: 0 }),
        }),
      );
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  // Bug regression (H1 symptoms 1+2): two SessionStart declarations, one configured-disabled
  // (admission skipLifecycle), one pending (admission blocked but participating in the lifecycle).
  // Before the fix: clientVisibleHookCount=2 and the skipLifecycle hook emitted no event → the projection saw
  // executions.length(1) < hookCount(2) → the row stayed running forever and the UI timer ticked without ending.
  // After the fix: the skipLifecycle hook is removed from the participating list → hookCount=1, one blocked
  // execution, and the state reaches a terminal value.
  it("H1 场景 A:configured-disabled + pending SessionStart → hookCount=1、1 blocked、state 终态", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-hook-h1-scenario-a-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo session-start-a",
                    enabled: false,
                  },
                ],
              },
              {
                hooks: [{ type: "command", command: "echo session-start-b" }],
              },
            ],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await app.submitPrompt("hello");

      // The configured-disabled hook runs no command
      // The pending hook is blocked too → no command executed
      expect(commands).toEqual([]);

      const events = await eventStore.getEvents(app.sessionId);
      const hookLifecycleEvents = events.filter(
        (event) =>
          event.type === SessionEventType.HookRunBlocked ||
          event.type === SessionEventType.HookRunStarted ||
          event.type === SessionEventType.HookRunCompleted ||
          event.type === SessionEventType.HookRunFailed,
      );

      // Only 1 blocked execution (the pending B); the configured-disabled A is entirely invisible
      expect(hookLifecycleEvents).toHaveLength(1);
      expect(hookLifecycleEvents[0]?.type).toBe(SessionEventType.HookRunBlocked);

      const payload = hookLifecycleEvents[0]?.payload as Record<string, unknown>;
      // hookCount must be 1, otherwise the projection waits for an execution that never arrives (the core H1 assertion)
      expect(payload.hookCount).toBe(1);
      expect(payload.errorCode).toBe("workspace_hooks_pending_trust");
      expect(payload.descriptor).toMatchObject({
        commandDisplay: "echo session-start-b",
      });

      // All events share the same hookInvocationId
      const invocationIds = new Set(
        hookLifecycleEvents.map(
          (event) => (event.payload as Record<string, unknown>).hookInvocationId,
        ),
      );
      expect(invocationIds.size).toBe(1);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  // Persistent trust only affects lifecycle events that occur naturally afterwards; SessionStart does no catch-up.
  it("两个 pending SessionStart 信任后，当前任务后续 turn 不补跑", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-hook-h2-scenario-b-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo session-start-a" }] },
              { hooks: [{ type: "command", command: "echo session-start-b" }] },
            ],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
      workspaceHookReviewHost: {
        taskId: "task-review",
        runId: "run-review",
        workspaceLabel: "Review workspace",
      },
    });
    try {
      // ── First turn: both SessionStart hooks pending → all blocked ──
      await app.submitPrompt("turn-1");
      expect(commands).toEqual([]);

      const turn1Events = await eventStore.getEvents(app.sessionId);
      const turn1Blocked = turn1Events.filter(
        (event) => event.type === SessionEventType.HookRunBlocked,
      );
      // 2 blocked executions
      expect(turn1Blocked).toHaveLength(2);
      // hookCount=2
      const turn1Payload = turn1Blocked[0]?.payload as Record<string, unknown>;
      expect(turn1Payload.hookCount).toBe(2);

      // ── Persistently trust every declaration in the current snapshot ──
      const admissionEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookAdmissionUpdated,
      );
      const admissionSnapshot = admissionEvent.payload as {
        bundleDigest: string;
        workspaceIdentity?: string;
      };
      await app.requestWorkspaceHookReview({
        workspaceIdentity: admissionSnapshot.workspaceIdentity!,
        bundleDigest: admissionSnapshot.bundleDigest,
      });
      const requestEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookReviewRequested,
      );
      const request = (requestEvent.payload as { request: any }).request;
      await expect(
        app.respondWorkspaceHookReview({
          sessionId: app.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
          decision: {
            action: "trust_selected",
            reviewItemIds: request.items.map((item: { reviewItemId: string }) => item.reviewItemId),
          },
        }),
      ).resolves.toMatchObject({ accepted: true });

      // ── Second turn: SessionStart does not catch up ──
      await app.submitPrompt("turn-2");
      expect(commands).toEqual([]);

      // ── Third turn: still no catch-up ──
      await app.submitPrompt("turn-3");
      expect(commands).toEqual([]);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });
});

async function waitForEvent(
  store: ReturnType<typeof createInMemorySessionEventStore>,
  sessionId: Parameters<typeof store.getEvents>[0],
  type: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = (await store.getEvents(sessionId)).find((candidate) => candidate.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function executionPort(commands: string[]): ExecutionPort {
  return {
    async run(request) {
      commands.push(
        request.command.mode === "shell" ? request.command.command : request.command.file,
      );
      const now = new Date("2026-08-06T00:00:00.000Z");
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

function stopModelExecutor() {
  return {
    async generateText() {
      return {
        finishReason: "stop",
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText() {
      yield {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never;
}
