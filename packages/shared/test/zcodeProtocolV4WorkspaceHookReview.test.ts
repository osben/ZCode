import { describe, expect, it } from "vitest";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  commandPayloadSchemas,
  conversationDeltaSchema,
  conversationSnapshotSchema,
  helloMessageSchema,
  hookExecutionDescriptorSchema,
  hostSupportsWorkspaceHookReview,
  hostSupportsWorkflowRunDeltas,
  clientSupportsWorkspaceHookReview,
  clientSupportsWorkflowRunDeltas,
  v4ConversationSubscribeParamsSchema,
  pendingInteractionSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookReviewRequestPayloadSchema,
} from "../src/zcode-protocol-v4/index.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
} from "../src/task-realtime-core.js";

const DIGEST = "a".repeat(64);

function request() {
  return workspaceHookReviewRequestPayloadSchema.parse({
    kind: "workspaceHookReview",
    reviewFlowId: "flow-1",
    generation: 2,
    interactionId: "interaction-2",
    sessionId: "session-1",
    taskId: "task-1",
    runId: "run-1",
    workspaceIdentity: "remote:ssh:host:/workspace",
    workspaceLabel: "workspace",
    remoteSessionId: "remote-1",
    bundleDigest: DIGEST,
    createdAt: 1,
    deadlineAt: 600_001,
    sourceFiles: [
      { path: "/workspace/.zcode/config.json", displayPath: ".zcode/config.json", editable: true },
    ],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "item-1",
        event: "SessionStart",
        matcher: "resume",
        type: "command",
        displayName: "SessionStart hook",
        displayCommand: "./scripts/resume.sh",
        sourcePath: ".zcode/config.json",
        resolvedTimeoutMs: 30_000,
        resolvedMaxOutputBytes: 32_768,
        executionMode: "background",
        configuredEnabled: true,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  });
}

function snapshotWithReview() {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "workspace", titleSource: "custom" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 0, maxTokens: 200_000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [
      {
        interactionId: "interaction-2",
        kind: "workspaceHookReview",
        anchorRowId: null,
        createdAt: 1,
        payload: request(),
      },
    ],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

// workflowRunDeltas capability bit (docs/v4-refactor/10-protocol-spec §4.5): the same family of fail-closed
// handshake as workspaceHookReview; pinned here because the pitfall is also the same — clientHello.capabilities is .strict().
describe("workflowRunDeltas capability handshake", () => {
  const hello = (capabilities: Record<string, unknown>) =>
    helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none",
        ...capabilities,
      },
      auth: {},
    });

  it("Host 侧缺失即 false，显式 true 才算有", () => {
    expect(hostSupportsWorkflowRunDeltas(hello({}).capabilities)).toBe(false);
    expect(hostSupportsWorkflowRunDeltas(hello({ workflowRunDeltas: false }).capabilities)).toBe(
      false,
    );
    expect(hostSupportsWorkflowRunDeltas(hello({ workflowRunDeltas: true }).capabilities)).toBe(
      true,
    );
  });

  it("Client 侧同样 fail closed；capabilities 整个缺席也只是 false", () => {
    const clientHello = (capabilities?: Record<string, unknown>) =>
      clientHelloSchema.parse({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "client-1",
        appVersion: "test",
        ...(capabilities === undefined ? {} : { capabilities }),
      });
    expect(clientSupportsWorkflowRunDeltas(clientHello())).toBe(false);
    expect(clientSupportsWorkflowRunDeltas(clientHello({ workspaceHookReviewUi: true }))).toBe(
      false,
    );
    expect(clientSupportsWorkflowRunDeltas(clientHello({ workflowRunDeltas: true }))).toBe(true);
    // The two capability bits do not interfere (two optional keys in the same strict object).
    expect(
      clientSupportsWorkspaceHookReview(
        clientHello({ workspaceHookReviewUi: true, workflowRunDeltas: true }),
      ),
    ).toBe(true);
  });

  it("clientHello.capabilities 是 .strict()：这正是「Host 没广播就不许声明」的由来", () => {
    // The old Host schema has no workflowRunDeltas key; a client sending it would make the **entire clientHello**
    // fail to parse and the handshake fail — not as mild as merely missing one key. This assertion reproduces that shape with a hypothetical future key.
    expect(
      clientHelloSchema.safeParse({
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "client-1",
        appVersion: "test",
        capabilities: { workflowRunDeltas: true, someFutureCapability: true },
      }).success,
    ).toBe(false);
  });

  it("subscribe 参数带该位（由可信 host 从连接的 clientHello 注入，UI 侧选不了）", () => {
    const params = v4ConversationSubscribeParamsSchema.parse({
      topic: "conversation/session-1",
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
      workflowRunDeltas: true,
    });
    expect(params.workflowRunDeltas).toBe(true);
    // Absent = treated as an old consumer (whole-key patch + old-UI trimming), not a parse failure.
    expect(
      v4ConversationSubscribeParamsSchema.parse({
        topic: "conversation/session-1",
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
      }).workflowRunDeltas,
    ).toBeUndefined();
  });
});

describe("workspaceHookReview protocol contracts", () => {
  it("Host/Client capabilities 对缺失值 fail closed，capable attachment 显式声明", () => {
    const hello = helloMessageSchema.parse({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    });
    expect(hostSupportsWorkspaceHookReview(hello.capabilities)).toBe(false);
    expect(
      hostSupportsWorkspaceHookReview({ ...hello.capabilities, workspaceHookReview: true }),
    ).toBe(true);

    expect(
      clientSupportsWorkspaceHookReview(
        clientHelloSchema.parse({
          kind: "clientHello",
          protocolVersion: V4_WIRE_PROTOCOL_VERSION,
          clientId: "client-1",
          appVersion: "test",
        }),
      ),
    ).toBe(false);
    expect(
      clientSupportsWorkspaceHookReview(
        clientHelloSchema.parse({
          kind: "clientHello",
          protocolVersion: V4_WIRE_PROTOCOL_VERSION,
          clientId: "client-2",
          appVersion: "test",
          capabilities: { workspaceHookReviewUi: true },
        }),
      ),
    ).toBe(true);
  });

  it("project Hook lifecycle descriptor 对客户端可见", () => {
    expect(
      hookExecutionDescriptorSchema.safeParse({
        clientVisible: true,
        sourceKind: "project",
        sourcePath: "/workspace/.zcode/config.json",
        executionType: "command",
        executionMode: "foreground",
        commandDisplay: "./scripts/start.sh",
        timeoutMs: 30_000,
      }).success,
    ).toBe(true);
  });

  it("workspaceHookReview 独立于 permission/userInput 且永不携带 autoResolution", () => {
    const interaction = pendingInteractionSchema.parse({
      interactionId: "interaction-2",
      kind: "workspaceHookReview",
      anchorRowId: null,
      createdAt: 1,
      payload: request(),
    });
    expect(interaction.kind).toBe("workspaceHookReview");

    expect(
      pendingInteractionSchema.safeParse({
        ...interaction,
        interactionId: "forged-interaction",
      }).success,
    ).toBe(false);

    expect(
      pendingInteractionSchema.safeParse({
        ...interaction,
        autoResolution: {
          state: "visibleCountdown",
          startedAt: 1,
          visibleAt: 2,
          deadlineAt: 3,
        },
      }).success,
    ).toBe(false);
  });

  it("Desktop continuous delta 与 mobile replayable snapshot 使用同一权威 projection", () => {
    const snapshot = conversationSnapshotSchema.parse(snapshotWithReview());
    expect(snapshot.pendingInteractions[0]?.payload.kind).toBe("workspaceHookReview");

    expect(
      conversationDeltaSchema.safeParse({
        op: "state.updated",
        patch: { pendingInteractions: snapshot.pendingInteractions },
      }).success,
    ).toBe(true);
  });

  it("decision schema 只允许精确持久信任，不再接受临时授权或批量/阻断动作", () => {
    expect(
      workspaceHookReviewDecisionSchema.safeParse({
        action: "trust_selected",
        reviewItemIds: ["item-1"],
      }).success,
    ).toBe(true);
    expect(
      workspaceHookReviewDecisionSchema.safeParse({
        action: "trust_selected",
        reviewItemIds: [],
      }).success,
    ).toBe(false);
    expect(
      workspaceHookReviewDecisionSchema.safeParse({
        action: "trust_selected",
        reviewItemIds: ["item-1", "item-1"],
      }).success,
    ).toBe(false);
    for (const legacyDecision of [
      { action: "trust_all" },
      { action: "allow_once" },
      { action: "allow_once", reviewItemIds: ["item-1"] },
      { action: "keep_blocked" },
    ]) {
      expect(
        workspaceHookReviewDecisionSchema.safeParse(legacyDecision).success,
        `${legacyDecision.action} 应已从 Workspace Hook 协议移除`,
      ).toBe(false);
    }
  });

  it("mobile replayable response 只能通过现有 owner/lease/stale-run command envelope", () => {
    const ownerRouteCommand = {
      commandRequestId: "owner-command-1",
      type: "respond_workspace_hook_review",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:/workspace",
      workspaceKey: "remote:ssh:host:/workspace",
      remoteSessionId: "remote-1",
      taskId: "task-1",
      runId: "run-1",
      sessionId: "session-1",
      bundleDigest: DIGEST,
      reviewFlowId: "flow-1",
      generation: 2,
      interactionId: "interaction-2",
      decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
    };

    expect(taskOwnerCommandRequestSchema.safeParse(ownerRouteCommand).success).toBe(true);
    expect(
      taskOwnerCommandDeliverySchema.safeParse({
        ...ownerRouteCommand,
        requesterHostId: "host-mobile-attachment",
      }).success,
    ).toBe(true);
    expect(
      taskOwnerCommandRequestSchema.safeParse({
        ...ownerRouteCommand,
        workspaceKey: "/workspace",
      }).success,
    ).toBe(false);
  });

  // —— Soft Gate S1 contract tests ——

  it("snapshot 旧数据(无 workspaceHookAdmission 字段)解析得 null", () => {
    const raw = snapshotWithReview();
    // Simulates an old sender: no workspaceHookAdmission field
    const parsed = conversationSnapshotSchema.parse(raw);
    expect(parsed.workspaceHookAdmission).toBeNull();
  });

  it("snapshot 带 workspaceHookAdmission 字段解析通过", () => {
    const raw = {
      ...snapshotWithReview(),
      workspaceHookAdmission: {
        pendingCount: 2,
        bundleDigest: DIGEST,
        workspaceIdentity: "remote:ssh:host:/workspace",
      },
    };
    const parsed = conversationSnapshotSchema.parse(raw);
    expect(parsed.workspaceHookAdmission).toEqual({
      pendingCount: 2,
      bundleDigest: DIGEST,
      workspaceIdentity: "remote:ssh:host:/workspace",
    });
  });

  it("workspaceHookAdmission 不带 workspaceIdentity 也可解析", () => {
    const raw = {
      ...snapshotWithReview(),
      workspaceHookAdmission: {
        pendingCount: 1,
        bundleDigest: DIGEST,
      },
    };
    const parsed = conversationSnapshotSchema.parse(raw);
    expect(parsed.workspaceHookAdmission).toEqual({
      pendingCount: 1,
      bundleDigest: DIGEST,
    });
  });

  it("workspaceHookAdmission.pendingCount 不允许负数", () => {
    const raw = {
      ...snapshotWithReview(),
      workspaceHookAdmission: {
        pendingCount: -1,
        bundleDigest: DIGEST,
      },
    };
    expect(conversationSnapshotSchema.safeParse(raw).success).toBe(false);
  });

  it("requestWorkspaceHookReview 命令 schema 校验通过(valid target)", () => {
    const payload = commandPayloadSchemas.requestWorkspaceHookReview.parse({
      sessionId: "session-1",
      workspaceIdentity: "remote:ssh:host:/workspace",
      bundleDigest: DIGEST,
    });
    expect(payload).toEqual({
      sessionId: "session-1",
      workspaceIdentity: "remote:ssh:host:/workspace",
      bundleDigest: DIGEST,
    });
  });

  it("requestWorkspaceHookReview 命令 schema 支持 remoteSessionId", () => {
    const payload = commandPayloadSchemas.requestWorkspaceHookReview.parse({
      sessionId: "session-1",
      remoteSessionId: "remote-1",
      workspaceIdentity: "remote:ssh:host:/workspace",
      bundleDigest: DIGEST,
    });
    expect(payload.remoteSessionId).toBe("remote-1");
  });

  it("requestWorkspaceHookReview 命令 schema 拒绝空 sessionId", () => {
    expect(
      commandPayloadSchemas.requestWorkspaceHookReview.safeParse({
        sessionId: "",
        workspaceIdentity: "remote:ssh:host:/workspace",
        bundleDigest: DIGEST,
      }).success,
    ).toBe(false);
  });

  it("requestWorkspaceHookReview 命令 schema 拒绝非 sha256 bundleDigest", () => {
    expect(
      commandPayloadSchemas.requestWorkspaceHookReview.safeParse({
        sessionId: "session-1",
        workspaceIdentity: "remote:ssh:host:/workspace",
        bundleDigest: "not-a-digest",
      }).success,
    ).toBe(false);
  });

  it("requestWorkspaceHookReview 命令 schema 拒绝多余字段(strict)", () => {
    expect(
      commandPayloadSchemas.requestWorkspaceHookReview.safeParse({
        sessionId: "session-1",
        workspaceIdentity: "remote:ssh:host:/workspace",
        bundleDigest: DIGEST,
        reviewFlowId: "flow-1",
      }).success,
    ).toBe(false);
  });
});
