// Golden tests for SessionsIndexProjection / SessionsIndexPublisher (M5 ①, 14-sessions-index):
// multi-session ConversationSnapshot → SessionSummary derivation + upsert/remove delta + conflation + frame
// accounting.
import { describe, expect, it } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  sessionsIndexSnapshotSchema,
  sessionsIndexTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  SessionsIndexProjection,
  deriveSessionSummary,
} from "../src/zcode-protocol-v4/sessions-index-projection.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";

function buildEvents(
  sessionId: string,
  build: (push: (type: SessionEventTypeUnion, payload: unknown, turnId?: string) => void) => void,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  let seq = 0;
  build((type, payload, turnId) => {
    seq += 1;
    events.push({
      id: `event-${sessionId}-${seq}` as EventId,
      sessionId: sessionId as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: seq,
      payload,
    });
  });
  return events;
}

function projectionFor(sessionId: string, events: SessionEvent[]): ProductProjection {
  const projection = new ProductProjection(sessionId, "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

describe("SessionsIndexProjection 黄金测试（L1）", () => {
  it("派生：title/phase/goal/hasBackgroundWork/preview 从会话快照取值", () => {
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "我的会话",
      });
      push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi", inputId: "query-1" }, "t1");
      push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "m1" },
        "t1",
      );
      push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "你好世界",
          done: false,
          assistantMessageId: "m1",
        },
        "t1",
      );
      push(SessionEventType.ModelStreaming, { kind: "text_end", delta: "", done: false }, "t1");
      push(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 0,
          resultType: "success",
          historyRoundCount: 2,
        },
        "t1",
      );
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
    });
    expect(summary.sessionId).toBe("s1");
    expect(summary.workspaceId).toBe("ws-1");
    expect(summary.title).toBe("我的会话");
    expect(summary.titleSource).toBe("custom");
    expect(summary.phase).toBe("completedSuccess");
    // control.sessionEnded is set by onTurnComplete to phase!=="error" (existing M2 semantics; the summary passes it
    // through faithfully).
    expect(summary.sessionEnded).toBe(true);
    expect(summary.hasBackgroundWork).toBe(false);
    expect(summary.lastAssistantPreview).toContain("你好世界");
    expect(summary.createdAt).toBe(1000);
    expect(summary.lastActivityAt).toBe(2000);
  });

  it("execution worktree facts flow from the derive extra into the summary and drive deltas", () => {
    const events = buildEvents("s-wt", (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    });
    const snapshot = projectionFor("s-wt", events).getSnapshot();
    const extra = {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
      executionWorktree: {
        path: "/repo/../worktrees/zcode-sleepy-capybara",
        branchName: "zcode/sleepy-capybara",
      },
    };
    const summary = deriveSessionSummary(snapshot, extra);
    expect(summary.executionWorktree).toEqual({
      path: "/repo/../worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
    });

    // Same facts again → no delta; a worktree appearing on a plain session → one upsert delta.
    const projection = new SessionsIndexProjection("ws-1", "epoch-1");
    const plainExtra = { workspaceId: "ws-1", createdAt: 1000, lastActivityAt: 2000 };
    expect(projection.upsertFromConversation(snapshot, plainExtra)).toHaveLength(1);
    expect(projection.upsertFromConversation(snapshot, plainExtra)).toHaveLength(0);
    const deltas = projection.upsertFromConversation(snapshot, extra);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      op: "session.upserted",
      session: { sessionId: "s-wt", executionWorktree: { branchName: "zcode/sleepy-capybara" } },
    });

    // The derived summary satisfies the wire schema (optional field round-trips).
    const parsed = sessionsIndexSnapshotSchema.safeParse(projection.getSnapshot());
    expect(parsed.success).toBe(true);
  });

  it("execution worktree missing flag rides at the summary top level and only-flag changes produce deltas", () => {
    const events = buildEvents("s-wt-missing", (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    });
    const snapshot = projectionFor("s-wt-missing", events).getSnapshot();
    const extra = {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
      executionWorktree: {
        path: "/repo/../worktrees/zcode-sleepy-capybara",
        branchName: "zcode/sleepy-capybara",
      },
      executionWorktreeMissing: true,
    };
    // Flag propagation: top-level only — the nested wire shape must stay free of runtime-only keys.
    const summary = deriveSessionSummary(snapshot, extra);
    expect(summary.executionWorktreeMissing).toBe(true);
    expect(summary.executionWorktree).toEqual({
      path: "/repo/../worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
    });

    // Scenario 9 (conflation): a flip whose only change is the flag produces a delta; repeating
    // the same flag does not, and absent ≈ false so a repeated healthy derive is a no-op.
    const projection = new SessionsIndexProjection("ws-1", "epoch-1");
    const healthyExtra = {
      createdAt: 1000,
      lastActivityAt: 2000,
      executionWorktree: {
        path: "/repo/../worktrees/zcode-sleepy-capybara",
        branchName: "zcode/sleepy-capybara",
      },
    };
    expect(projection.upsertFromConversation(snapshot, healthyExtra)).toHaveLength(1);
    expect(projection.upsertFromConversation(snapshot, healthyExtra)).toHaveLength(0);
    const missingDeltas = projection.upsertFromConversation(snapshot, {
      ...healthyExtra,
      executionWorktreeMissing: true,
    });
    expect(missingDeltas).toHaveLength(1);
    expect(missingDeltas[0]).toMatchObject({
      op: "session.upserted",
      session: { sessionId: "s-wt-missing", executionWorktreeMissing: true },
    });
    expect(
      projection.upsertFromConversation(snapshot, {
        ...healthyExtra,
        executionWorktreeMissing: true,
      }),
    ).toHaveLength(0);
    const missingSnapshotParse = sessionsIndexSnapshotSchema.safeParse(projection.getSnapshot());
    expect(missingSnapshotParse.success).toBe(true);
    // Recreated worktree (flag omitted again) is a real health flip, not a no-op.
    expect(projection.upsertFromConversation(snapshot, healthyExtra)).toHaveLength(1);
    // The healthy state still satisfies the wire schema after clearing the flag.
    const parsed = sessionsIndexSnapshotSchema.safeParse(projection.getSnapshot());
    expect(parsed.success).toBe(true);
  });

  it("incognito flag rides at the summary top level and only-flag changes produce deltas", () => {
    const events = buildEvents("s-incognito", (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    });
    const snapshot = projectionFor("s-incognito", events).getSnapshot();
    const extra = { workspaceId: "ws-1", createdAt: 1000, lastActivityAt: 2000 };

    expect(deriveSessionSummary(snapshot, { ...extra, incognito: true }).incognito).toBe(true);
    expect("incognito" in deriveSessionSummary(snapshot, extra)).toBe(false);

    const projection = new SessionsIndexProjection("ws-1", "epoch-1");
    projection.upsertFromConversation(snapshot, extra);
    expect(projection.upsertFromConversation(snapshot, { ...extra, incognito: true })).toHaveLength(
      1,
    );
    expect(projection.upsertFromConversation(snapshot, { ...extra, incognito: true })).toHaveLength(
      0,
    );
    expect(sessionsIndexSnapshotSchema.safeParse(projection.getSnapshot()).success).toBe(true);
  });

  it("hasBackgroundWork：有 running 后台任务时为 true", () => {
    const events = buildEvents("s2", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.BackgroundTaskStarted, {
        taskId: "bg-1",
        toolName: "Bash",
        command: "sleep 100",
        status: "running",
      });
    });
    const snapshot = projectionFor("s2", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(summary.hasBackgroundWork).toBe(true);
  });

  it("workflowActivity：从 workflowRuns + workflow 后台工作派生；活动时间不变时只改 node 的事件判等，phase 翻转必产帧", () => {
    const runProgress = (
      push: (type: SessionEventTypeUnion, payload: unknown) => void,
      sequence: number,
      eventType: string,
      payload: Record<string, unknown>,
    ) =>
      push(SessionEventType.DynamicWorkflowRunProgress, {
        runId: "run-1",
        toolCallId: "tool-1",
        sequence,
        eventType,
        payload,
      });
    const events = buildEvents("s-wf", (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
      push(SessionEventType.BackgroundTaskStarted, {
        taskId: "run-1",
        toolName: "CreateWorkflow",
        taskKind: "workflow",
        description: "Deep research",
        status: "running",
      });
      runProgress(push, 0, "run-started", { runId: "run-1", caps: { maxConcurrency: 4 } });
      runProgress(push, 1, "run-launched", {
        inputId: "in-1",
        phaseNames: ["Research", "Write"],
        // Research's strand is still running when Write is entered: the sidebar draws a double-line segment between
        // the two stations based on this.
        phaseAlongside: [[], [0]],
      });
      runProgress(push, 2, "phase-entered", { name: "Research", ordinal: 1 });
      runProgress(push, 3, "actor-created", {
        actor: { siteId: "actor#1", ordinal: 1 },
        name: "Scout",
      });
      runProgress(push, 4, "node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      });
      runProgress(push, 5, "node-executing", { instance: { siteId: "ask#1", ordinal: 1 } });
    });
    const projection = projectionFor("s-wf", events);
    const summary = deriveSessionSummary(projection.getSnapshot(), {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(summary.hasBackgroundWork).toBe(true);
    expect(summary.workflowActivity).toEqual({
      runs: [
        {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "Deep research",
          status: "running",
          startedAt: expect.any(Number),
          phases: [
            { name: "Research", status: "running" },
            { name: "Write", status: "pending", alongside: [0] },
          ],
          currentPhase: "Research",
          agentsWorking: 1,
        },
      ],
    });

    // Events for the same run that only change node / usage but not phase / status / subagent count: the summaries
    // compare equal and no sidebar frame is produced.
    const index = new SessionsIndexProjection("ws-1", "epoch-1");
    expect(
      index.upsertFromConversation(projection.getSnapshot(), { createdAt: 1, lastActivityAt: 2 }),
    ).toHaveLength(1);
    const nodeOnly = buildEvents("s-wf", (push) => {
      runProgress(push, 6, "node-queued", {
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      });
      runProgress(push, 7, "usage-updated", { spentTokens: 120 });
    });
    for (const event of nodeOnly) projection.applyEvent(event);
    expect(
      index.upsertFromConversation(projection.getSnapshot(), { createdAt: 1, lastActivityAt: 2 }),
    ).toEqual([]);
    // Entering the next phase produces a delta, and the station lamps flip with it.
    const [phase] = buildEvents("s-wf", (push) =>
      runProgress(push, 8, "phase-entered", { name: "Write", ordinal: 1 }),
    );
    projection.applyEvent(phase!);
    const deltas = index.upsertFromConversation(projection.getSnapshot(), {
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(deltas).toHaveLength(1);
    const delta = deltas[0]!;
    if (delta.op !== "session.upserted") throw new Error("expected upsert");
    expect(delta.session.workflowActivity?.runs[0]?.phases.map((p) => p.status)).toEqual([
      "done",
      "running",
    ]);
  });

  it("projects the head interaction auto-resolution state into the lightweight summary", () => {
    const events = buildEvents("s-ask", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.PermissionRequested, {
        requestId: "ask-1",
        toolCallId: "tool-1",
        toolName: "AskUserQuestion",
        riskLevel: "low",
        reason: "Need input",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Choose?",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
          ],
        },
      });
      push(SessionEventType.UserInputAutoResolutionUpdated, {
        interactionId: "ask-1",
        toolCallId: "tool-1",
        autoResolution: {
          state: "visibleCountdown",
          startedAt: 1_000,
          visibleAt: 61_000,
          deadlineAt: 301_000,
        },
      });
    });
    const summary = deriveSessionSummary(projectionFor("s-ask", events).getSnapshot(), {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });

    expect(summary.pendingInteraction).toEqual({
      interactionId: "ask-1",
      kind: "userInput",
      toolName: "AskUserQuestion",
      autoResolution: {
        state: "visibleCountdown",
        startedAt: 1_000,
        visibleAt: 61_000,
        deadlineAt: 301_000,
      },
    });
  });

  it("只投影 pending interaction 的 kind/count，不下发 payload", () => {
    const events = buildEvents("s-interactions", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const baseSnapshot = projectionFor("s-interactions", events).getSnapshot();
    const summary = deriveSessionSummary(
      {
        ...baseSnapshot,
        pendingInteractions: [
          { kind: "permission" } as never,
          { kind: "permission" } as never,
          { kind: "userInput" } as never,
        ],
      },
      {
        workspaceId: "ws-1",
        createdAt: 1,
        lastActivityAt: 2,
      },
    );

    expect(summary.pendingInteractionSummary).toEqual({
      permissionCount: 2,
      userInputCount: 1,
    });
    expect(summary).not.toHaveProperty("pendingInteractions");
  });

  it("不把 workspace Hook review 降级成 permission/userInput 侧栏状态", () => {
    const events = buildEvents("s-workspace-review", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const baseSnapshot = projectionFor("s-workspace-review", events).getSnapshot();
    const summary = deriveSessionSummary(
      {
        ...baseSnapshot,
        pendingInteractions: [
          {
            interactionId: "workspace-review-1",
            kind: "workspaceHookReview",
            payload: { kind: "workspaceHookReview" },
          } as never,
        ],
      },
      {
        workspaceId: "ws-1",
        createdAt: 1,
        lastActivityAt: 2,
      },
    );

    expect(summary).not.toHaveProperty("pendingInteraction");
    expect(summary).not.toHaveProperty("pendingInteractionSummary");
  });

  it("index：upsert 变化才产 delta（conflation），remove 命中产 delta", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const extra = { createdAt: 1, lastActivityAt: 2 };

    // The first upsert produces a delta
    const d1 = index.upsertFromConversation(snapshot, extra);
    expect(d1).toHaveLength(1);
    expect(d1[0]).toMatchObject({ op: "session.upserted" });

    // Same snapshot + extra → idempotent, no delta
    const d2 = index.upsertFromConversation(snapshot, extra);
    expect(d2).toHaveLength(0);

    // lastActivityAt changed → another upsert
    const d3 = index.upsertFromConversation(snapshot, {
      createdAt: 1,
      lastActivityAt: 3,
    });
    expect(d3).toHaveLength(1);

    // The snapshot contains the session
    expect(index.getSnapshot().sessions.map((s) => s.sessionId)).toEqual(["s1"]);

    // A hit on remove produces a delta; removing again is idempotent
    expect(index.remove("s1")).toHaveLength(1);
    expect(index.remove("s1")).toHaveLength(0);
    expect(index.getSnapshot().sessions).toHaveLength(0);
  });

  it("index：stored→live 降级防御——live 空标题/新时间不得覆盖 store 种子", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    // Store seed: with title and original times (simulating a sidebar cold start).
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "项目分析与优化",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      lastAssistantPreview: "旧预览",
      createdAt: 10,
    });
    // The live projection of a cold recovery: before hydration meta.title is empty and the record times were reset to
    // "now" by the resume path.
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    index.upsertFromConversation(snapshot, {
      createdAt: 9_999,
      lastActivityAt: 9_999,
    });
    const merged = index.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(merged?.title).toBe("项目分析与优化");
    expect(merged?.createdAt).toBe(10);
    expect(merged?.lastAssistantPreview).toBe("旧预览");
    // Bugfix assertion: the live projection's phase before hydration is the initial draft and must not downgrade the
    // terminal baseline.
    expect(merged?.phase).toBe("completedSuccess");
    expect(merged?.sessionEnded).toBe(true);
  });

  it("index：冷恢复 draft 窗口快照与基线等价时不产 delta（打开历史任务不刷列表）", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "项目分析与优化",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      lastAssistantPreview: "旧预览",
      createdAt: 10,
    });
    // Cold-recovery live projection (hydration not finished): phase=draft, no title/preview;
    // the record times were backfilled by the resume path to the store's real times (lastActivityAt matches).
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const deltas = index.upsertFromConversation(snapshot, {
      createdAt: 10,
      lastActivityAt: 100,
    });
    // Every field is protected by the downgrade defense → summariesEqual → zero deltas, the UI list does not move.
    expect(deltas).toHaveLength(0);
  });

  it("index：多会话快照 schema 合法 + 无序聚合", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    for (const sid of ["a", "b", "c"]) {
      const events = buildEvents(sid, (push) => {
        push(SessionEventType.SessionCreated, {
          mode: "default",
          contextWindow: 200_000,
        });
      });
      index.upsertFromConversation(projectionFor(sid, events).getSnapshot(), {
        createdAt: 1,
        lastActivityAt: 2,
      });
    }
    const snap = index.getSnapshot();
    expect(snap.sessions).toHaveLength(3);
    expect(new Set(snap.sessions.map((s) => s.sessionId))).toEqual(new Set(["a", "b", "c"]));
    // Frame schema validity
    expect(() => sessionsIndexSnapshotSchema.parse(snap)).not.toThrow();
  });

  it("fork：parentSessionId 透传", () => {
    const events = buildEvents("child", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("child", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
      parentSessionId: "parent",
    });
    expect(summary.parentSessionId).toBe("parent");
  });
});

describe("SessionsIndexPublisher 单测（帧记账）", () => {
  let clock = 1000;
  const now = () => (clock += 1);

  function snap(sessionId: string): ReturnType<ProductProjection["getSnapshot"]> {
    const events = buildEvents(sessionId, (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    return projectionFor(sessionId, events).getSnapshot();
  }

  it("subscribe → snapshot 帧（fromSeq=0），帧 schema 合法", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const res = pub.subscribe("conn-1");
    expect(res.mode).toBe("snapshot");
    expect(res.frame?.payload.kind).toBe("snapshot");
    expect(res.frame?.fromSeq).toBe(0);
    expect(() => sessionsIndexTopicFrameSchema.parse(res.frame)).not.toThrow();
  });

  it("订阅后 ingest → flush 出增量帧（(fromSeq, toSeq]）", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    const res = pub.subscribe("conn-1");
    const baseSeq = res.frame?.toSeq ?? 0;
    // A new session arrives → there are changes
    expect(pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 })).toBe(true);
    const frame = pub.flush(res.subscriptionId);
    expect(frame?.payload.kind).toBe("deltas");
    expect(frame?.fromSeq).toBe(baseSeq);
    expect(frame?.toSeq).toBe(pub.seq);
    if (frame?.payload.kind === "deltas") {
      expect(frame.payload.deltas[0]).toMatchObject({ op: "session.upserted" });
    }
    // Drained → a further flush returns null
    expect(pub.flush(res.subscriptionId)).toBeNull();
  });

  it("幂等 ingest 不产帧；resume base=当前 seq → frame null", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    // The same snapshot ingested again → no change
    expect(pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 })).toBe(false);
    const res = pub.subscribe("conn-1", { logEpoch: "epoch-1", seq: pub.seq });
    expect(res.mode).toBe("resume");
    expect(res.frame).toBeNull();
  });

  it("removeSession → remove delta 帧", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const res = pub.subscribe("conn-1");
    expect(pub.removeSession("a")).toBe(true);
    const frame = pub.flush(res.subscriptionId);
    if (frame?.payload.kind === "deltas") {
      expect(frame.payload.deltas[0]).toMatchObject({
        op: "session.removed",
        sessionId: "a",
      });
    } else {
      throw new Error("expected deltas frame");
    }
  });

  it("异代际 base → 退化 snapshot；重订阅替换旧代际（同 connection 新 subscriptionId）", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const stale = pub.subscribe("conn-1", { logEpoch: "other-epoch", seq: 1 });
    expect(stale.mode).toBe("snapshot");
    expect(stale.frame?.payload.kind).toBe("snapshot");
    const replaced = pub.subscribe("conn-1");
    expect(replaced.subscriptionId).not.toBe(stale.subscriptionId);
    expect(pub.subscriptionIds()).toEqual([replaced.subscriptionId]);
  });
});

describe("sidebar child-conversation facts", () => {
  function plainSnapshot(sessionId: string) {
    const events = buildEvents(sessionId, (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    });
    return projectionFor(sessionId, events).getSnapshot();
  }

  const childrenA = [
    {
      sessionId: "child-sub-1",
      title: "research adapters",
      taskType: "subagent_child" as const,
      lastActivityAt: 50,
      running: true,
    },
    {
      sessionId: "child-chat-1",
      title: "side chat",
      taskType: "selection_side_chat" as const,
      lastActivityAt: 40,
      running: false,
    },
  ];

  it("child counters and the capped list flow from the derive extra onto the summary and the wire schema", () => {
    const summary = deriveSessionSummary(plainSnapshot("s-parent"), {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
      sideChatCount: 1,
      subagentCount: 2,
      runningSubagentCount: 1,
      childSessions: childrenA,
    });
    expect(summary.sideChatCount).toBe(1);
    expect(summary.subagentCount).toBe(2);
    expect(summary.runningSubagentCount).toBe(1);
    expect(summary.childSessions).toEqual(childrenA);
    // The summary with child facts must stay a valid wire snapshot payload.
    const parsed = sessionsIndexSnapshotSchema.parse({
      protocolVersion: 1,
      workspaceId: "ws-1",
      logEpoch: "epoch-1",
      sessions: [summary],
    });
    expect(parsed.sessions[0].childSessions).toHaveLength(2);
  });

  it("absent child facts render no fields, and a counters- or list-only change emits an upsert delta", () => {
    const plain = deriveSessionSummary(plainSnapshot("s-plain"), {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
    });
    expect(plain.sideChatCount).toBeUndefined();
    expect(plain.childSessions).toBeUndefined();

    const projection = new SessionsIndexProjection("ws-1", "log-epoch-1");
    const snapshot = plainSnapshot("s-parent");
    const base = { createdAt: 1000, lastActivityAt: 2000 };
    const withFacts = {
      ...base,
      sideChatCount: 1,
      subagentCount: 2,
      runningSubagentCount: 1,
      childSessions: childrenA,
    };
    expect(projection.upsertFromConversation(snapshot, withFacts).length).toBeGreaterThan(0);
    // Identical facts → conflated away.
    expect(projection.upsertFromConversation(snapshot, withFacts)).toEqual([]);
    // Counters-only change (running subagent finished) must emit an upsert delta.
    const settled = projection.upsertFromConversation(snapshot, {
      ...withFacts,
      runningSubagentCount: 0,
      childSessions: childrenA.map((child) => ({ ...child, running: false })),
    });
    expect(settled.length).toBeGreaterThan(0);
    expect(settled[0]).toMatchObject({
      op: "session.upserted",
      // runningSubagentCount normalizes to absent at 0; the children flipping to not-running is the visible change.
      session: { childSessions: [{ running: false }, { running: false }] },
    });
  });

  it("updates child facts on a cold summary without changing session activity", () => {
    const projection = new SessionsIndexProjection("ws-1", "log-epoch-1");
    projection.seed({
      ...deriveSessionSummary(plainSnapshot("s-cold-parent"), {
        workspaceId: "ws-1",
        createdAt: 1000,
        lastActivityAt: 2000,
      }),
      title: "Parent conversation",
    });

    const deltas = projection.updateChildFacts("s-cold-parent", {
      sideChatCount: 1,
      subagentCount: 1,
      runningSubagentCount: 1,
      childSessions: [childrenA[0]!],
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      op: "session.upserted",
      session: {
        sessionId: "s-cold-parent",
        title: "Parent conversation",
        lastActivityAt: 2000,
        sideChatCount: 1,
        subagentCount: 1,
        runningSubagentCount: 1,
        childSessions: [childrenA[0]],
      },
    });
    expect(projection.updateChildFacts("s-cold-parent", {
      sideChatCount: 1,
      subagentCount: 1,
      runningSubagentCount: 1,
      childSessions: [childrenA[0]!],
    })).toEqual([]);

    expect(projection.updateChildFacts("s-cold-parent", {})).toMatchObject([
      { op: "session.upserted", session: { lastActivityAt: 2000, title: "Parent conversation" } },
    ]);
    expect(projection.getSnapshot().sessions[0]).not.toHaveProperty("childSessions");
  });
});
