import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderRuntimeHeadersResponseSchema,
  zcodeProtocolMethods,
  zcodeProtocolMessageSchema,
  zcodeProcessResourceSampleSchema,
  zcodeProtocolNotifications,
  zcodeMcpListParamsSchema,
  zcodeModelFormatPropertiesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionEventSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionSettingsStateSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCheckTaskBindingResultSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeAutomationProtocolSchema,
  zcodeProviderRateLimitsSchema,
  zcodeWorkspaceGenerateTextResultSchema,
} from "../src/zcode-protocol/index.js";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
} from "../src/app-runtime-preferences.js";
import { zcodeUserMessageInfoSchema } from "../src/zcode-protocol-legacy-types.js";
import { conversationRowSchema, workflowLaunchMetaSchema } from "../src/zcode-protocol-v4/rows.js";
import { errorAttributionSchema } from "../src/zcode-protocol-v4/snapshot.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceIdentity: "remote:ssh:dev:/workspace/app",
  workspaceKey: "remote:ssh:dev:/workspace/app",
};

const model = {
  providerId: "glm",
  modelId: "glm-4.6",
};

const modelProperties = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: true,
  },
  outputFormat: { supportsText: true },
};

describe("ZCode Protocol", () => {
  it("模型格式能力只接受完整的嵌套 properties 契约", () => {
    const properties = {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
    };

    expect(zcodeModelFormatPropertiesSchema.parse(properties)).toEqual(properties);
    expect(() =>
      zcodeModelFormatPropertiesSchema.parse({
        supportsImages: true,
        supportsPdf: true,
        supportsVideo: false,
      }),
    ).toThrow();
    expect(() =>
      zcodeModelFormatPropertiesSchema.parse({
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
      }),
    ).toThrow();
  });

  it("普通 Session 命令拒绝 Host runtimeModel 快照", () => {
    const runtimeModel = {
      revision: "model-runtime:test",
      generatedAt: 1,
      model,
      provider: {
        providerId: model.providerId,
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        baseURL: "https://example.com",
        models: [{ modelId: model.modelId }],
      },
    };

    const payloads = [
      [zcodeSessionCreateParamsSchema, { workspace, model, runtimeModel }],
      [zcodeSessionResumeParamsSchema, { sessionId: "session-1", runtimeModel }],
      [
        zcodeSessionSendParamsSchema,
        {
          sessionId: "session-1",
          content: "hello",
          expectedModelRuntimeRevision: runtimeModel.revision,
          runtimeModel,
        },
      ],
      [zcodeSessionCompactParamsSchema, { sessionId: "session-1", runtimeModel }],
      [zcodeSessionSetModelParamsSchema, { sessionId: "session-1", model, runtimeModel }],
      [
        zcodeSessionSetThoughtLevelParamsSchema,
        { sessionId: "session-1", thoughtLevel: "high", runtimeModel },
      ],
    ] as const;

    for (const [schema, payload] of payloads) {
      expect(() => schema.parse(payload)).toThrow();
    }
  });

  it("accepts only bounded process resource samples without workspace or session identity", () => {
    const sample = {
      arch: "arm64",
      cpuCores: 2.5,
      cpuPercent: 31.25,
      intervalMs: 60_000,
      logicalCpuCount: 8,
      platform: "darwin",
      rssKb: 65_536,
    };

    expect(zcodeProtocolNotifications.processResourceSample).toBe("process/resourceSample");
    // PRT-025: samples from old CLIs lack the new fields and must still pass validation (all new fields optional; the handshake version does not bump).
    expect(zcodeProcessResourceSampleSchema.parse(sample)).toEqual(sample);
    const sampleWithTelemetryFields = {
      ...sample,
      heapUsedKb: 20_480,
      uptimeMinutes: 12,
      totalMemoryGb: 16,
      instanceToken: "9f2c4a1b7d0e5638",
    };
    expect(zcodeProcessResourceSampleSchema.parse(sampleWithTelemetryFields)).toEqual(
      sampleWithTelemetryFields,
    );
    // lane is labeled by app-side services from the owning process manager; the CLI does not know its own lane and may not self-report.
    expect(() => zcodeProcessResourceSampleSchema.parse({ ...sample, lane: "chat" })).toThrow();
    // instanceToken exists only for main to count processes; it must never smuggle pids, paths, or workspace identity.
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, instanceToken: "/private/repo" }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, instanceToken: "" }),
    ).toThrow();
    expect(() => zcodeProcessResourceSampleSchema.parse({ ...sample, heapUsedKb: -1 })).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, uptimeMinutes: 1.5 }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        workspacePath: "/private/repo",
      }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        cpuCores: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        logicalCpuCount: 0,
      }),
    ).toThrow();
  });

  it("accepts only the four privacy-bounded MCP telemetry events", () => {
    const base = {
      arch: "arm64",
      occurredAt: 1_000,
      platform: "darwin",
    } as const;
    const events = [
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:node_repl",
        mcpInstanceId: "mcp-instance-1",
        mcpIsolation: "workspace",
        mcpSource: "builtin",
      },
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:zcode-cua:computer-use",
        mcpInstanceId: "mcp-instance-2",
        mcpIsolation: "session",
        mcpSource: "builtin",
      },
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:document-skills:image%20search%2F%E9%AB%98%E6%B8%85",
        mcpInstanceId: "mcp-instance-3",
        mcpIsolation: "session",
        mcpSource: "builtin",
      },
      {
        ...base,
        affectedSessionCount: 2,
        exitCode: 1,
        kind: "process_crash",
        mcpId: "builtin:node_repl",
        mcpInstanceId: "mcp-instance-1",
        mcpIsolation: "workspace",
        mcpSource: "builtin",
        signal: null,
        uptimeMs: 10_000,
      },
      {
        ...base,
        configuredCount: 3,
        connectedCount: 2,
        failedCount: 1,
        kind: "session_startup",
        processCount: 1,
        sessionId: "session-1",
      },
      {
        ...base,
        kind: "memory",
        mcpId: "custom:123456789abc",
        mcpInstanceId: "mcp-instance-2",
        mcpIsolation: "session",
        mcpSource: "custom",
        memoryKb: 65_536,
        memoryScope: "process_tree",
        orphanSuspected: true,
        ownerSessionCount: 0,
        unownedSeconds: 60.001,
      },
    ];

    expect(zcodeProtocolNotifications.mcpTelemetry).toBe("process/mcpTelemetry");
    expect(events.map((event) => zcodeMcpTelemetryEventSchema.parse(event))).toEqual(events);
    expect(() =>
      zcodeMcpTelemetryEventSchema.parse({
        ...events[0],
        mcpServerName: "private-company-server",
      }),
    ).toThrow();
  });

  it("accepts a default thought level in session settings", () => {
    expect(
      zcodeSessionSettingsStateSchema.parse({
        model: {
          current: model,
          available: [{ ref: model, label: "GLM 4.6", properties: modelProperties }],
        },
        thoughtLevel: {
          enabled: true,
          current: undefined,
          defaultLevel: "max",
          available: [
            { value: "high", label: "High" },
            { value: "max", label: "Max" },
          ],
        },
        mode: {
          current: "build",
        },
      }),
    ).toMatchObject({
      thoughtLevel: {
        defaultLevel: "max",
      },
    });
  });

  it("uses reasoning presence as support and rejects removed model-option projections", () => {
    const currentModelOption = {
      ref: model,
      label: "GLM 4.6",
      properties: modelProperties,
      reasoning: { levels: [{ value: "high", label: "High" }] },
    };

    expect(
      zcodeSessionSettingsStateSchema.parse({
        model: { current: model, available: [currentModelOption] },
        thoughtLevel: { enabled: true, available: [], current: undefined },
        mode: { current: "build" },
      }).model.available[0]?.reasoning?.levels,
    ).toHaveLength(1);

    for (const removedField of [
      "providerSource",
      "providerLogoUrl",
      "supportsTools",
      "supportsStructuredOutput",
      "supportsJsonSchemaOutput",
    ]) {
      expect(() =>
        zcodeSessionSettingsStateSchema.parse({
          model: {
            current: model,
            available: [{ ...currentModelOption, [removedField]: true }],
          },
          thoughtLevel: { enabled: true, available: [], current: undefined },
          mode: { current: "build" },
        }),
      ).toThrow();
    }

    expect(() =>
      zcodeSessionSettingsStateSchema.parse({
        model: {
          current: model,
          available: [{ ...currentModelOption, reasoning: { enabled: true, levels: [] } }],
        },
        thoughtLevel: { enabled: true, available: [], current: undefined },
        mode: { current: "build" },
      }),
    ).toThrow();
  });

  it("validates the dedicated app runtime preference broadcast payload", () => {
    expect(APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL).toBe(
      "settings:app-runtime-preferences",
    );
    expect(
      appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
        askUserQuestionAutoResolutionEnabled: false,
      }),
    ).toEqual({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
    expect(() =>
      appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
        askUserQuestionAutoResolutionEnabled: false,
        ignored: true,
      }),
    ).toThrow();
  });

  it("accepts bounded browser ambient context on session/send while staying strict", () => {
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: {
          tabCount: 1,
          currentUrl: "https://example.com/current?q=1",
        },
      }).browserAmbientContext,
    ).toEqual({ tabCount: 1, currentUrl: "https://example.com/current?q=1" });
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: { tabCount: 0 },
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: { tabCount: 1, pageText: "secret" },
      }),
    ).toThrow();
  });

  it("session/send accepts Off-Peak turn attribution but rejects competing automation identity", () => {
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        offPeakTaskId: "offpeak-1",
        offPeakRunType: "resume",
      }),
    ).toMatchObject({ offPeakTaskId: "offpeak-1", offPeakRunType: "resume" });
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "invalid",
        offPeakRunType: "init",
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        automationId: "automation-1",
        offPeakTaskId: "offpeak-1",
      }),
    ).toThrow();
  });

  it("session/send and automation/create validate the bot delivery target strictly", () => {
    const botDeliveryTarget = {
      provider: "weixin" as const,
      botId: "bot-weixin",
      providerUserId: "chat-1",
      chatType: "private" as const,
    };
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "创建定时任务",
        botDeliveryTarget,
      }).botDeliveryTarget,
    ).toEqual(botDeliveryTarget);
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "0 9 * * *",
        prompt: "日报",
        botDeliveryTarget,
      }).botDeliveryTarget,
    ).toEqual(botDeliveryTarget);
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "0 9 * * *",
        prompt: "日报",
        botDeliveryTarget: { ...botDeliveryTarget, provider: "discord" },
      }),
    ).toThrow();
  });

  it("keeps protocol methods session-first and private", () => {
    const methods = Object.values(zcodeProtocolMethods);

    expect(methods).not.toContain("capabilities");
    expect(methods.every((method) => !method.includes("task"))).toBe(true);
    expect(methods).toContain("session/read");
    expect(methods).toContain("session/usage");
    expect(methods).toContain("session/subagents");
    expect(methods).toContain("session/treeCounts");
    expect(methods).toContain("session/eraseTree");
    expect(methods).toContain("session/setModel");
    expect(methods).toContain("session/cancelBackgroundTask");
    expect(methods).toContain("workspace/readPresentation");
    expect(methods).not.toContain("workspace/readState");
    expect(methods).not.toContain("workspace/setDefaultModel");
    expect(methods).not.toContain("workspace/setDefaultThoughtLevel");
    expect(methods).toContain("automation/create");
    expect(methods).toContain("automation/update");
  });

  it("validates the strict Computer Use operation lifecycle notification", () => {
    expect(zcodeProtocolMethods.computerUseOperationEvent).toBe("computer-use/operation-event");

    const base = {
      eventId: "evt-1",
      sequenceNumber: 1,
      sessionId: "sess-1",
      timestamp: 1_700_000_000_000,
    };
    for (const event of [
      { ...base, kind: "turn-started", turnId: "turn-1" },
      { ...base, kind: "turn-completed", turnId: "turn-1" },
      { ...base, kind: "turn-failed", turnId: "turn-1" },
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "mcp__computer-use__left_click",
      },
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-node-repl",
        toolName: "mcp__node_repl__js",
        computerUse: true,
      },
      {
        ...base,
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "call-1",
      },
      { ...base, kind: "session-closed" },
    ]) {
      expect(zcodeComputerUseOperationEventSchema.safeParse(event).success).toBe(true);
    }

    for (const event of [
      { ...base, eventId: "", kind: "session-closed" },
      { ...base, sequenceNumber: -1, kind: "session-closed" },
      { ...base, kind: "turn-started" },
      { ...base, kind: "tool-scheduled", turnId: "turn-1", toolCallId: "call-1" },
      // computerUse is a boolean fact where only true carries meaning; false and the action name are both outside the contract.
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "mcp__node_repl__js",
        computerUse: false,
      },
      // tool-started cannot obtain the model source code (ToolCallStartedPayload has no input), so it may not carry this fact.
      {
        ...base,
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "call-1",
        computerUse: true,
      },
      { ...base, kind: "tool-started", toolCallId: "" },
      { ...base, kind: "session-closed", toolName: "must-not-pass" },
      { ...base, kind: "unknown-kind" },
    ]) {
      expect(zcodeComputerUseOperationEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("workspace/readPresentation 只接受 workspace identity", () => {
    expect(() =>
      zcodeWorkspaceReadPresentationParamsSchema.parse({
        workspace,
        runtimeModel: {},
      }),
    ).toThrow();
    expect(zcodeWorkspaceReadPresentationParamsSchema.parse({ workspace })).toEqual({ workspace });
  });

  it("preserves automation runtime config in strict protocol schemas", () => {
    const create = zcodeAutomationCreateParamsSchema.parse({
      title: "daily report",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      modelSelection: {
        providerId: "glm",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      mode: "plan",
    });
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        title: "3分钟后提醒",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 3,
        prompt: "提醒我",
        recurring: false,
      }),
    ).toMatchObject({ relativeDelayMinutes: 3, recurring: false });
    expect(create).toMatchObject({
      modelSelection: {
        providerId: "glm",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      mode: "plan",
    });

    expect(
      zcodeAutomationProtocolSchema.parse({
        automationId: "automation-1",
        ...create,
        enabled: true,
        lifecycleStatus: "active",
        runCount: 0,
        recurring: true,
      }),
    ).toMatchObject({ mode: "plan", modelSelection: { modelId: "glm-5.2" } });

    expect(
      zcodeAutomationProtocolSchema.parse({
        automationId: "automation-default-mode",
        title: "daily report",
        cronExpr: "0 9 * * *",
        prompt: "summarize",
        mode: "default",
        enabled: true,
        lifecycleStatus: "active",
        runCount: 0,
        recurring: true,
      }),
    ).toMatchObject({ mode: "default" });
  });

  it("将会话 Cron interval carrier 严格限制为 1-200 并要求成对提交", () => {
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
        interval: 200,
      }),
    ).toMatchObject({ intervalUnit: "minute", interval: 200 });
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
        interval: 201,
      }),
    ).toThrow();
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
      }),
    ).toThrow();

    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 200,
      }),
    ).toMatchObject({ intervalUnit: "yearly", interval: 200 });
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 1.5,
      }),
    ).toThrow();
    // carrier must stay an endless loop, avoiding the host receiving a contradictory state of recurring=false / a finite count.
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 200,
        recurring: true,
        maxRuns: null,
      }),
    ).toMatchObject({ recurring: true, maxRuns: null });
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(() =>
        zcodeAutomationUpdateParamsSchema.parse({
          automationId: "automation-1",
          intervalUnit: "yearly",
          interval: 200,
          ...invalidMode,
        }),
      ).toThrow();
    }
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(() =>
        zcodeAutomationCreateParamsSchema.parse({
          cronExpr: "* * * * *",
          prompt: "提醒我",
          intervalUnit: "minute",
          interval: 200,
          ...invalidMode,
        }),
      ).toThrow();
    }
  });

  it("validates the dedicated automation task-binding query", () => {
    expect(
      zcodeAutomationCheckTaskBindingParamsSchema.parse({ targetTaskId: "session-1" }),
    ).toEqual({ targetTaskId: "session-1" });
    expect(zcodeAutomationCheckTaskBindingResultSchema.parse({ bound: true })).toEqual({
      bound: true,
    });
    expect(() =>
      zcodeAutomationCheckTaskBindingParamsSchema.parse({ targetTaskId: " " }),
    ).toThrow();
    expect(() =>
      zcodeAutomationCheckTaskBindingResultSchema.parse({ bound: false, automations: [] }),
    ).toThrow();
  });

  it("validates a strict non-empty automation update patch", () => {
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        cronExpr: "0 10 * * *",
        recurring: true,
        maxRuns: null,
      }),
    ).toEqual({
      automationId: "automation-1",
      cronExpr: "0 10 * * *",
      recurring: true,
      maxRuns: null,
    });
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: true,
      }),
    ).toEqual({
      automationId: "automation-1",
      recurring: true,
    });

    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({ automationId: "automation-1" }),
    ).toThrow();
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        title: "new title",
        enabled: false,
      }),
    ).toThrow();
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        maxRuns: null,
      }),
    ).toThrow("clearing maxRuns requires recurring=true");
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: false,
        maxRuns: null,
      }),
    ).toThrow("clearing maxRuns requires recurring=true");
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: true,
        maxRuns: 3,
      }),
    ).toThrow("recurring=true cannot be combined with a numeric maxRuns");
  });

  it("accepts an explicit session title-generation switch while staying strict", () => {
    expect(
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        titleGenerationEnabled: false,
      }).titleGenerationEnabled,
    ).toBe(false);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        titleGenerationEnabled: "false",
      }),
    ).toThrow();
  });

  it("validates the paged session subagent projection", () => {
    expect(
      zcodeSessionSubagentsParamsSchema.parse({
        sessionId: "sess_parent",
        endedCursor: "cursor-20",
        endedLimit: 20,
      }),
    ).toEqual({
      sessionId: "sess_parent",
      endedCursor: "cursor-20",
      endedLimit: 20,
    });

    expect(
      zcodeSessionSubagentsResultSchema.parse({
        revision: 7,
        childSessionIds: ["sess_child_running", "sess_child_failed"],
        running: [
          {
            childSessionId: "sess_child_running",
            subagentType: "Explore",
            title: "Inspect the renderer",
            status: "waiting",
            startedAt: 10,
          },
        ],
        ended: {
          total: 1,
          items: [
            {
              childSessionId: "sess_child_failed",
              subagentType: "Plan",
              title: "Plan the migration",
              summary: "Provider request failed",
              status: "failed",
              startedAt: 1,
              endedAt: 9,
            },
          ],
          nextCursor: "cursor-40",
        },
      }),
    ).toMatchObject({
      revision: 7,
      childSessionIds: ["sess_child_running", "sess_child_failed"],
      running: [{ status: "waiting" }],
      ended: { total: 1, items: [{ status: "failed" }] },
    });

    expect(() =>
      zcodeSessionSubagentsParamsSchema.parse({
        sessionId: "sess_parent",
        endedLimit: 0,
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSubagentsResultSchema.parse({
        revision: 0,
        childSessionIds: ["sess_child"],
        running: [],
        ended: {
          total: 1,
          items: [
            {
              childSessionId: "sess_child",
              subagentType: "Explore",
              title: "Inspect",
              status: "running",
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("parses JSON-RPC style messages without requiring a jsonrpc field", () => {
    const parsed = zcodeProtocolMessageSchema.parse({
      id: "request-1",
      method: "session/read",
      params: {
        sessionId: "sess_1",
      },
    });

    expect(parsed).toMatchObject({
      id: "request-1",
      method: "session/read",
    });
  });

  it("allows MCP list requests to carry explicit MCP servers", () => {
    expect(
      zcodeMcpListParamsSchema.parse({
        workspace,
        mcpServers: [
          {
            name: "agents-fallback",
            command: "node",
            args: ["server.mjs"],
            env: [{ name: "TOKEN", value: "secret" }],
            timeoutMs: 3000,
          },
        ],
      }),
    ).toMatchObject({
      workspace,
      mcpServers: [
        {
          name: "agents-fallback",
          command: "node",
          args: ["server.mjs"],
          env: [{ name: "TOKEN", value: "secret" }],
          timeoutMs: 3000,
        },
      ],
    });
  });

  it("accepts MCP servers on session create and resume params while staying strict", () => {
    const mcpServers = [
      {
        name: "chrome-devtools",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
        env: [],
        timeoutMs: 3,
      },
      {
        name: "linear",
        type: "http",
        url: "https://mcp.example.test",
        headers: [{ name: "Authorization", value: "Bearer token" }],
        timeoutMs: 5000,
      },
      {
        name: "events",
        type: "sse",
        url: "https://mcp.example.test/sse",
        headers: [],
        timeoutMs: 8000,
      },
    ];

    expect(zcodeSessionCreateParamsSchema.parse({ workspace, mcpServers }).mcpServers).toEqual(
      mcpServers,
    );
    expect(
      zcodeSessionResumeParamsSchema.parse({
        sessionId: "sess_1",
        workspace,
        mcpServers,
      }).mcpServers,
    ).toEqual(mcpServers);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        mcpServers: [
          {
            ...mcpServers[0],
            tokenShouldNotPass: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts session create tool lists while staying strict", () => {
    const parsed = zcodeSessionCreateParamsSchema.parse({
      workspace,
      toolAllowlist: ["mcp__zcode-cua__request_access", "mcp__zcode-cua__list_apps"],
      toolDenylist: ["Bash"],
    });

    expect(parsed.toolAllowlist).toEqual([
      "mcp__zcode-cua__request_access",
      "mcp__zcode-cua__list_apps",
    ]);
    expect(parsed.toolDenylist).toEqual(["Bash"]);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        toolAllowlist: ["Read"],
        unexpectedToolPolicy: true,
      }),
    ).toThrow();
  });

  it("accepts session RESUME tool lists too (cold resume keeps the same isolation)", () => {
    // Cold resume must keep the same tool-surface constraints as create, otherwise a CUA session would re-expose Bash and other denied tools after resume.
    const parsed = zcodeSessionResumeParamsSchema.parse({
      sessionId: "sess_1",
      toolAllowlist: ["mcp__zcode-cua__request_access"],
      toolDenylist: ["Bash"],
    });
    expect(parsed.toolAllowlist).toEqual(["mcp__zcode-cua__request_access"]);
    expect(parsed.toolDenylist).toEqual(["Bash"]);
    // Still strict: unknown fields rejected.
    expect(() =>
      zcodeSessionResumeParamsSchema.parse({
        sessionId: "sess_1",
        unexpectedToolPolicy: true,
      }),
    ).toThrow();
  });

  it("models provider runtime header refresh as a strict interaction request", () => {
    const params = zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
      requestId: "header-refresh-1",
      sessionId: "sess_1",
      turnId: "turn_1",
      workspace,
      modelSelection: model,
      providerId: "account:zai-individual-coding-plan",
      reason: "model-request",
    });
    // Current request-scoped auth material supersedes request-level headers; the old Registry revision or bare headers protocol cannot be restored.
    const runtimeProviderHeaders = {
      "X-Request-Scoped-Param": "request-token",
      "X-Request-Scoped-Region": "cn",
    };
    const response = zcodeProviderRuntimeHeadersResponseSchema.parse({
      headersApplied: true,
      requestAuth: {
        apiKey: "request-key",
        headers: { "X-Request": "request-header", ...runtimeProviderHeaders },
      },
    });
    expect(response).toMatchObject({ requestAuth: { headers: runtimeProviderHeaders } });
    expect(() =>
      zcodeProviderRuntimeHeadersResponseSchema.parse({
        headersApplied: true,
      }),
    ).toThrow();
    expect(() =>
      zcodeProviderRuntimeHeadersResponseSchema.parse({
        headersApplied: true,
        runtimeProviderHeaders,
        providerRevision: "rev-2",
      }),
    ).toThrow();

    expect(zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders).toBe(
      "interaction/requestProviderRuntimeHeaders",
    );
    expect(() =>
      zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        ...params,
        staleHeader: "must-not-pass-through",
      }),
    ).toThrow();
  });

  it.each(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"] as const)(
    "runtime headers 直接接受 Registry zhipu access mode: %s",
    (mode) => {
      const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        requestId: `request-${mode}`,
        sessionId: "sess_1",
        workspace,
        modelSelection: model,
        providerId: `account:${mode}`,
        accountAccess: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode,
          entitled: true,
        },
        reason: "model-request",
      });

      expect(parsed.accountAccess).toEqual({
        type: "zhipu-account",
        accountType: "bigmodel",
        mode,
        entitled: true,
      });
    },
  );

  it("runtime headers 拒绝已经退出 Registry 的旧 planKind Access 形状", () => {
    expect(() =>
      zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        requestId: "request-legacy",
        sessionId: "sess_1",
        workspace,
        modelSelection: model,
        providerId: "account:legacy",
        accountAccess: {
          type: "zhipu-account",
          accountType: "bigmodel",
          planKind: "team-coding-plan",
        },
        reason: "model-request",
      }),
    ).toThrow();
  });

  it("parses subagent mirrored tool updates with explicit protocol metadata", () => {
    const scheduled = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_tool_scheduled",
      seq: 12,
      sessionId: "sess_parent",
      timestamp: 13,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Read",
        input: { filePath: "/workspace/app.ts" },
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        description: "Inspect workspace",
      },
    });
    const started = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_tool_started",
      seq: 13,
      sessionId: "sess_parent",
      timestamp: 14,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "tool_subagent_agent_1_call_1",
        startedAt: 14,
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        description: "Inspect workspace",
      },
    });

    expect(scheduled.payload.parentToolCallId).toBe("call_parent_agent");
    expect(started.payload.source).toBe("subagent");
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...scheduled,
        payload: {
          ...scheduled.payload,
          unknownSubagentField: true,
        },
      }),
    ).toThrow();
  });

  it("parses background subagent mirrored tool updates", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_background_subagent_tool_started",
      seq: 14,
      sessionId: "sess_parent",
      timestamp: 15,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "tool_subagent_agent_1_call_1",
        startedAt: 15,
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        background: true,
      },
    });

    expect(event.payload.background).toBe(true);
  });

  it("parses subagent mirrored permission events with routing metadata", () => {
    const requested = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_permission_requested",
      seq: 14,
      sessionId: "sess_parent",
      timestamp: 15,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "permission.requested",
      payload: {
        requestId: "permission_1",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Run workspace tests",
        input: { command: "pnpm test" },
        childSessionId: "sess_subagent_agent_1",
        background: true,
        options: [
          {
            optionId: "allow_once",
            kind: "allowOnce",
            name: "Allow once",
            response: { decision: "allow" },
          },
        ],
      },
    });
    const resolved = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_permission_resolved",
      seq: 15,
      sessionId: "sess_parent",
      timestamp: 16,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "permission.resolved",
      payload: {
        requestId: "permission_1",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Bash",
        decision: "allow",
        childSessionId: "sess_subagent_agent_1",
        background: true,
      },
    });

    expect(requested.payload.childSessionId).toBe("sess_subagent_agent_1");
    expect(requested.payload.background).toBe(true);
    expect(resolved.payload.childSessionId).toBe("sess_subagent_agent_1");
    expect(resolved.payload.background).toBe(true);
  });

  it("parses scheduled tool updates that reference model-streamed input", () => {
    const scheduled = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_scheduled_tombstone",
      seq: 15,
      sessionId: "sess_parent",
      timestamp: 16,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_1",
        toolName: "Write",
        inputByteLength: 32768,
        inputOmitted: true,
        inputRef: "model_stream",
      },
    });

    expect(scheduled.payload.inputOmitted).toBe(true);
    expect(scheduled.payload.inputRef).toBe("model_stream");
    expect("input" in scheduled.payload).toBe(false);
  });

  describe.each(["desktop-continuous", "web-remote-replayable"])(
    "scheduled tool message ownership (%s)",
    (deliveryKind) => {
      it.each([
        { input: { command: "sleep 20" } },
        { inputByteLength: 128, inputOmitted: true, inputRef: "model_stream" },
      ])("preserves ownership for input form %j while keeping strict validation", (input) => {
        const event = {
          eventId: "evt_scheduled_ownership",
          seq: 1,
          sessionId: "sess_ownership",
          timestamp: 1,
          deliveryKind,
          type: "tool.updated",
          payload: {
            kind: "scheduled",
            toolCallId: "call_ownership",
            toolName: "Bash",
            ...input,
          },
        };

        // Old CLIs without message attribution fields must stay compatible; the new CLI's fields must not drop the whole scheduling event.
        expect(zcodeSessionEventSchema.parse(event).payload).toEqual(event.payload);
        const payload = { ...event.payload, assistantMessageId: "msg_assistant" };
        expect(zcodeSessionEventSchema.parse({ ...event, payload })).toEqual({ ...event, payload });

        for (const assistantMessageId of ["", null, 42]) {
          expect(
            zcodeSessionEventSchema.safeParse({
              ...event,
              payload: { ...payload, assistantMessageId },
            }).success,
          ).toBe(false);
        }
        expect(
          zcodeSessionEventSchema.safeParse({
            ...event,
            payload: { ...payload, unknownField: true },
          }).success,
        ).toBe(false);
      });
    },
  );

  it("parses a server-authoritative session state snapshot", () => {
    const snapshot = zcodeSessionStateSnapshotSchema.parse({
      protocol: {
        name: ZCODE_PROTOCOL_NAME,
        version: ZCODE_PROTOCOL_VERSION,
      },
      session: {
        sessionId: "sess_1",
        workspace,
        sessionKind: "interactive",
        title: "Build login flow",
        titleSource: "generated",
        mode: "build",
        status: "idle",
        model,
        createdAt: 1,
        updatedAt: 2,
      },
      settings: {
        model: {
          current: model,
          available: [{ ref: model, label: "GLM 4.6", properties: modelProperties }],
          lastUsed: model,
        },
        thoughtLevel: {
          enabled: true,
          current: "medium",
          available: [{ value: "medium", label: "Medium" }],
        },
        mode: {
          current: "build",
        },
      },
      projection: {
        sessionId: "sess_1",
        status: "idle",
        mode: "build",
        turnCount: 1,
        totalTokenCount: 0,
        contextUsed: 0,
        contextWindow: 128000,
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
        lastError: {
          type: "MODEL_ERROR",
          code: "provider_not_found",
          message: "Model provider is not configured: stale-provider",
          detail: "stale-provider/gpt-5.5",
          attribution: {
            source: "runtime",
            reason: "provider_not_configured",
            providerId: "account:zai-individual-coding-plan",
            retryable: false,
          },
        },
      },
      runtime: {
        eventSeq: 7,
        stateRevision: 3,
        deliveryKind: "desktop-continuous",
        pendingRequestIds: [],
      },
      messages: [
        {
          info: {
            messageId: "msg_1",
            sessionId: "sess_1",
            role: "user",
            time: { created: 1 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_1",
              sessionId: "sess_1",
              messageId: "msg_1",
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    });

    expect(snapshot.settings.model.current.providerId).toBe("glm");
    expect(snapshot.session.titleSource).toBe("generated");
    expect(snapshot.projection.lastError).toEqual({
      type: "MODEL_ERROR",
      code: "provider_not_found",
      message: "Model provider is not configured: stale-provider",
      detail: "stale-provider/gpt-5.5",
      attribution: {
        source: "runtime",
        reason: "provider_not_configured",
        providerId: "account:zai-individual-coding-plan",
        retryable: false,
      },
    });
    expect(snapshot.runtime.stateRevision).toBe(3);
  });

  it("parses agent-owned session title update events", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_title_1",
      seq: 8,
      sessionId: "sess_1",
      timestamp: 9,
      traceId: "trace_title_1",
      type: "session.titleUpdated",
      payload: {
        previousTitle: "please fix the mobile login button",
        source: "generated",
        title: "Fix mobile login",
      },
    });

    expect(event.type).toBe("session.titleUpdated");
    expect(event.payload).toMatchObject({ title: "Fix mobile login" });
  });

  it("preserves attribution on legacy turn.failed events", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_failed_1",
      seq: 9,
      sessionId: "sess_1",
      timestamp: 10,
      type: "turn.failed",
      payload: {
        turnPhase: "model",
        error: {
          type: "MODEL_ERROR",
          code: "model_request_failed",
          message: "Model request failed.",
          attribution: {
            source: "provider",
            reason: "unknown",
            errorPhase: "response",
            exceptionKind: "api_call",
            providerId: "account:zai-start-plan",
            providerErrorCode: "3012",
            statusCode: 405,
          },
        },
      },
    });

    expect(event.payload.error.attribution).toEqual({
      source: "provider",
      reason: "unknown",
      errorPhase: "response",
      exceptionKind: "api_call",
      providerId: "account:zai-start-plan",
      providerErrorCode: "3012",
      statusCode: 405,
    });
  });

  it("rejects raw exception names from error attribution", () => {
    expect(() =>
      errorAttributionSchema.parse({
        errorPhase: "stream",
        exceptionKind: "SecretProviderNetworkError",
      }),
    ).toThrow();
  });

  it("accepts complete steer queue and drain facts emitted by the CLI", () => {
    const queued = zcodeSessionEventSchema.parse({
      eventId: "evt_steer_queued_1",
      seq: 9,
      sessionId: "sess_1",
      timestamp: 10,
      type: "turn.steerQueued",
      payload: {
        pendingInputId: "pending_1",
        inputId: "input_1",
        queryId: "query_1",
        input: "继续检查",
        inputPreview: "继续检查",
        inputSize: 4,
        delivery: "guide",
        intent: { delivery: "guide", sourceCommandId: "command_1" },
        toolDisallowlist: ["Write"],
        targetTurnId: "turn_1",
        queueLength: 1,
      },
    });
    const drained = zcodeSessionEventSchema.parse({
      eventId: "evt_steer_drained_1",
      seq: 10,
      sessionId: "sess_1",
      timestamp: 11,
      type: "turn.steerDrained",
      payload: {
        pendingInputIds: ["pending_1"],
        queryIds: ["query_1"],
        targetTurnId: "turn_1",
        injectedMessageIds: ["message_1"],
        drainedInputs: [
          {
            pendingInputId: "pending_1",
            messageId: "message_1",
            text: "继续检查",
            delivery: "guide",
            intent: { delivery: "guide", sourceCommandId: "command_1" },
            toolDisallowlist: ["Write"],
          },
        ],
      },
    });

    expect(queued.payload).toMatchObject({ delivery: "guide" });
    expect(drained.payload).toMatchObject({
      drainedInputs: [{ messageId: "message_1", delivery: "guide" }],
    });
  });

  it("parses typed session events for tool updates", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_1",
      seq: 12,
      sessionId: "sess_1",
      timestamp: 13,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_1",
        toolName: "Edit",
        duration: 42,
        result: {
          success: true,
          content: "done",
        },
      },
    });

    expect(event.type).toBe("tool.updated");
    expect(event.payload.kind).toBe("result");
  });

  it("strictly validates bounded Node REPL image display payloads", () => {
    const event = {
      eventId: "evt_tool_image_1",
      seq: 13,
      sessionId: "sess_1",
      timestamp: 14,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_image_1",
        toolName: "mcp__node_repl__js",
        duration: 42,
        result: {
          success: true,
          content: "(no output)\n\n[Attached image/png: MCP image]",
          display: {
            kind: "node_repl_images",
            images: [{ base64: "AAAA", mimeType: "image/png" }],
            source: "browser_turn_end",
          },
        },
      },
    };

    expect(zcodeSessionEventSchema.parse(event).payload).toMatchObject({
      kind: "result",
      result: {
        display: { kind: "node_repl_images", source: "browser_turn_end" },
      },
    });
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          result: {
            ...event.payload.result,
            display: {
              ...event.payload.result.display,
              unbounded: true,
            },
          },
        },
      }),
    ).toThrow();
  });

  it("keeps browser turn-end image displays in strict v4 tool rows", () => {
    const row = conversationRowSchema.parse({
      rowId: 4,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 4,
      kind: "toolCall",
      toolCallId: "tool-browser-turn-end",
      toolName: "mcp__node_repl__js",
      status: "success",
      inputText: "",
      display: {
        kind: "node_repl_images",
        source: "browser_turn_end",
        images: [{ base64: "AAAA", mimeType: "image/png" }],
      },
    });

    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    });
  });

  it("keeps the official MCP unavailable code in strict v4 tool rows", () => {
    // The two strict schemas (CLI contracts' display payload and the row here) must add fields in sync;
    // missing one side rejects the whole row and the composer hint would never receive the fact.
    const row = conversationRowSchema.parse({
      rowId: 5,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 5,
      kind: "toolCall",
      toolCallId: "tool-official-mcp",
      toolName: "mcp__zcode-official__search_image",
      status: "success",
      inputText: "{}",
      display: {
        kind: "mcp_tool",
        serverName: "zcode-official",
        toolName: "search_image",
        unavailable: { code: "quota_exceeded" },
      },
    });

    expect(row).toMatchObject({
      display: { kind: "mcp_tool", unavailable: { code: "quota_exceeded" } },
    });
    // internal_error is not in the code enum: it is the server's fallback mask and does not drive UI messaging. Out-of-enum values
    // are therefore **not carried** — with display ungated the row remains valid, but the card has no payload (§4.4.5).
    const maskedRow = conversationRowSchema.parse({
      rowId: 6,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 6,
      kind: "toolCall",
      toolCallId: "tool-official-mcp",
      toolName: "mcp__zcode-official__search_image",
      status: "success",
      inputText: "{}",
      display: {
        kind: "mcp_tool",
        serverName: "zcode-official",
        toolName: "search_image",
        unavailable: { code: "internal_error" },
      },
    });
    expect(maskedRow.kind === "toolCall" ? maskedRow.display : "unreachable").toBeUndefined();
  });

  it("strictly validates bounded CreateWorkflow display payloads", () => {
    const event = {
      eventId: "evt_tool_workflow_1",
      seq: 15,
      sessionId: "sess_1",
      timestamp: 16,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_1",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: false,
          content: "The workflow script has type errors:",
          display: {
            kind: "create_workflow",
            ok: false,
            errorCount: 1,
            diagnostics: [{ line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." }],
          },
        },
      },
    };

    expect(zcodeSessionEventSchema.parse(event).payload).toMatchObject({
      kind: "result",
      result: { display: { kind: "create_workflow", ok: false, errorCount: 1 } },
    });
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          result: {
            ...event.payload.result,
            display: { ...event.payload.result.display, unbounded: true },
          },
        },
      }),
    ).toThrow();
  });

  it("keeps bounded CreateWorkflow diagnostics displays in strict v4 tool rows", () => {
    const row = conversationRowSchema.parse({
      rowId: 6,
      turnId: "turn-1",
      createdAt: 12,
      createdAtSeq: 6,
      kind: "toolCall",
      toolCallId: "tool-create-workflow",
      toolName: "CreateWorkflow",
      status: "error",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: false,
        errorCount: 2,
        diagnostics: [
          { line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." },
          { line: 8, column: 1, code: 1005, message: "';' expected." },
        ],
        truncated: true,
      },
    });

    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "create_workflow", ok: false, errorCount: 2, truncated: true },
    });
  });

  it("accepts the bounded CreateWorkflow causality graph on both protocol boundaries", () => {
    const causalityGraph = {
      steps: [
        {
          id: "world-read#1",
          kind: "world-read",
          label: "glob *.ts",
          line: 1,
          column: 20,
          lane: "workspace",
        },
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          line: 2,
          column: 24,
          lane: "actor#1",
          repeat: "serial",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "reviewer",
          // The static shape of an interpolated name: the v3 mirror once missed these two pattern fields (0a8b059f40 only
          // touched contracts and v4), and under .strict() the whole graph failed validation — pinned in this dual-boundary case.
          labelPattern: { head: "研究员", tail: "号" },
          line: 3,
          column: 24,
          lane: "actor#2",
          lanes: ["actor#2", "actor#3"],
          repeat: "stack",
        },
      ],
      lanes: [
        { id: "workspace" },
        { id: "actor#1", name: "planner", line: 2, column: 17 },
        { id: "actor#2", name: "reviewer", line: 3, column: 17 },
        { id: "actor#3", namePattern: { head: "研究员" }, line: 4, column: 17 },
      ],
      // The second layer is subagent-oriented (docs/dynamic-workflow/presentation.md): one participant card per phase;
      // with no phase vocabulary phase is always `unphased`. Families with literal cardinality get one `member` card each,
      // unknown cardinality gets one `many` card. Also pinned in the dual-boundary case to prevent one-sided edits.
      participants: [
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
        {
          id: "unphased:actor#2[0]",
          phase: "unphased",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 0, of: 2 },
        },
        {
          id: "unphased:actor#2[1]",
          phase: "unphased",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 1, of: 2 },
        },
        {
          id: "unphased:actor#3",
          phase: "unphased",
          lane: "actor#3",
          steps: ["ask#2"],
          many: true,
        },
      ],
      // One arrow kind: runs after; `back: true` only marks loop-back edges (single-arrow-contract spec);
      // `types` are the artifact types crossing this handoff (inspector material, not on the arrow).
      handoffs: [
        { from: "unphased:workspace", to: "unphased:actor#1" },
        { from: "unphased:actor#1", to: "unphased:actor#2[0]", types: ["Plan"] },
        { from: "unphased:actor#1", to: "unphased:actor#2[1]", types: ["Plan"] },
        { from: "unphased:actor#2[0]", to: "unphased:actor#1", back: true },
      ],
      sink: ["ask#2"],
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_graph",
      seq: 16,
      sessionId: "sess_1",
      timestamp: 17,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_graph",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: true,
          content: "The workflow script compiled cleanly.",
          display: {
            kind: "create_workflow",
            ok: true,
            errorCount: 0,
            diagnostics: [],
            causalityGraph,
          },
        },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { kind: "create_workflow", ok: true, causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const row = conversationRowSchema.parse({
      rowId: 7,
      turnId: "turn-1",
      createdAt: 13,
      createdAtSeq: 7,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-graph",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph,
      },
    });
    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "create_workflow", ok: true, causalityGraph },
    });
  });

  // Typed holes (docs/dynamic-workflow/authoring.md "Holes"): `hole` sites, `fill` on steps / phases, the graph's
  // `holes[]`, and the FillWorkflowHole row's top-level `fill`. dwf-recursive only touched contracts and v4; the v3 mirror
  // rejected the whole tool.updated under .strict() and the desktop's v3 subscription lost that card — same class as labelPattern above.
  it("carries typed-hole fields through both the legacy event and v4 rows", () => {
    const causalityGraph = {
      steps: [
        { id: "ask#1", kind: "ask", label: "planner", lane: "actor#1", phase: "phase#1" },
        {
          id: "hole#1a2b3c4d",
          kind: "hole",
          label: "verdict",
          lane: "main",
          phase: "hole#1a2b3c4d",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "judge",
          lane: "actor#2",
          phase: "phase#2",
          fill: "hole#1a2b3c4d",
        },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "judge" },
      ],
      participants: [
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        { id: "phase#2:actor#2", phase: "phase#2", lane: "actor#2", steps: ["ask#2"] },
      ],
      handoffs: [{ from: "phase#1:actor#1", to: "phase#2:actor#2" }],
      phases: [
        { id: "phase#1", name: "plan" },
        { id: "hole#1a2b3c4d", name: "verdict" },
        { id: "phase#2", name: "judge", fill: "hole#1a2b3c4d" },
      ],
      phaseEdges: [
        { from: "phase#1", to: "hole#1a2b3c4d" },
        { from: "hole#1a2b3c4d", to: "phase#2" },
      ],
      holes: [
        {
          siteId: "hole#1a2b3c4d",
          name: "verdict",
          type: "Verdict",
          phase: "hole#1a2b3c4d",
          tail: true,
        },
      ],
      exits: ["phase#2"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
      fill: { siteId: "hole#1a2b3c4d", name: "verdict", draftPath: "/tmp/fill.ts", line: 3 },
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_holes",
      seq: 22,
      sessionId: "sess_1",
      timestamp: 23,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_holes",
        toolName: "FillWorkflowHole",
        duration: 7,
        result: { success: true, content: "The hole is filled.", display },
      },
    });
    expect(event.payload).toMatchObject({ kind: "result", result: { display } });

    // V4 rows: toolCallRow.display.
    const row = conversationRowSchema.parse({
      rowId: 11,
      turnId: "turn-1",
      createdAt: 17,
      createdAtSeq: 11,
      kind: "toolCall",
      toolCallId: "tool-fill-workflow-hole",
      toolName: "FillWorkflowHole",
      status: "success",
      inputText: "",
      display,
    });
    expect(row).toMatchObject({ kind: "toolCall", display });
  });

  it("rejects an out-of-bounds CreateWorkflow causality graph in strict v4 tool rows", () => {
    const base = {
      rowId: 8,
      turnId: "turn-1",
      createdAt: 14,
      createdAtSeq: 8,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-graph-bounds",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    const display = { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] };
    const step = {
      id: "ask#1",
      kind: "ask",
      label: "a",
      lane: "actor#1",
    };
    const participant = {
      id: "unphased:actor#1",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
    };
    const graph = {
      steps: [step],
      lanes: [{ id: "actor#1" }],
      participants: [participant],
      handoffs: [],
    };
    // display on v4 rows is ungated (docs/v4-refactor/10-protocol-spec.md §4.4.5): an unrecognized payload is
    // dropped while the row itself stays valid, instead of rejecting the whole frame. So this helper asserts "the graph
    // was carried" — it throws proactively when dropped, so each toThrow / not.toThrow below keeps its original meaning.
    // Boundedness is not relaxed: out-of-bounds payloads still never reach the UI; only the cost changes (reject the frame,
    // tearing down the subscription → the card degrades to plain text).
    const parseWith = (causalityGraph: unknown) => {
      const row = conversationRowSchema.parse({ ...base, display: { ...display, causalityGraph } });
      if (row.kind !== "toolCall" || row.display === undefined) {
        throw new Error("v4 row dropped the create_workflow display");
      }
      return row.display;
    };

    expect(() => parseWith(graph)).not.toThrow();

    // 65 steps exceed the 64-step bound.
    expect(() =>
      parseWith({
        ...graph,
        steps: Array.from({ length: 65 }, (_, index) => ({ ...step, id: `ask#${index}` })),
      }),
    ).toThrow();

    // A 129-char label exceeds the label bound.
    expect(() => parseWith({ ...graph, steps: [{ ...step, label: "n".repeat(129) }] })).toThrow();

    // 65 participants exceed the 64-participant bound.
    expect(() =>
      parseWith({
        ...graph,
        participants: Array.from({ length: 65 }, (_, index) => ({
          ...participant,
          id: `unphased:actor#1[${index}]`,
          member: { index, of: 65 },
        })),
      }),
    ).toThrow();

    // 一张卡至少一个 step；member = {index ≥ 0, of ≥ 1} strict；many 只接受字面量 true。
    expect(() =>
      parseWith({
        ...graph,
        participants: [{ ...participant, id: "unphased:actor#1[1]", member: { index: 1, of: 2 } }],
      }),
    ).not.toThrow();
    expect(() =>
      parseWith({ ...graph, participants: [{ ...participant, member: { of: 2 } }] }),
    ).toThrow();

    // Handoff edges carry only {from, to, back?, types?}: the analyzer's kind / certainty do not enter the display payload.
    const handoff = { from: "unphased:actor#1", to: "unphased:actor#1" };
    // 257 handoffs exceed the 256-handoff bound.
    expect(() =>
      parseWith({ ...graph, handoffs: Array.from({ length: 257 }, () => handoff) }),
    ).toThrow();

    // `types`, when present, is 1..8 names, each ≤ 128 chars.
    expect(() =>
      parseWith({ ...graph, handoffs: [{ ...handoff, types: ["Flaky"] }] }),
    ).not.toThrow();
    expect(() => parseWith({ ...graph, handoffs: [{ ...handoff, types: [""] }] })).toThrow();
  });

  it("accepts may-set lane-expansion copies with `source` on both protocol boundaries", () => {
    // May-set lane expansion: one ask site becomes one copy per candidate lane, with `source` recording the site id it
    // expanded from (the live overlay's correlation key). The field is additive, so old payloads without source still validate.
    const copy = {
      id: "ask#2~actor#1",
      kind: "ask",
      label: "ask",
      line: 7,
      column: 58,
      lane: "actor#1",
      lanes: ["actor#1", "actor#2"],
      source: "ask#2",
      repeat: "serial",
    };
    const causalityGraph = {
      steps: [copy, { ...copy, id: "ask#2~actor#2", lane: "actor#2" }],
      lanes: [
        { id: "actor#1", name: "black" },
        { id: "actor#2", name: "white" },
      ],
      // One participant card per candidate lane; the card's steps point at that lane's copy ids.
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#2~actor#1"] },
        { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#2~actor#2"] },
      ],
      handoffs: [
        { from: "unphased:actor#1", to: "unphased:actor#2", back: true },
        { from: "unphased:actor#2", to: "unphased:actor#1", back: true },
      ],
      sink: ["ask#2~actor#1", "ask#2~actor#2"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_may_set",
      seq: 18,
      sessionId: "sess_1",
      timestamp: 19,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_may_set",
        toolName: "CreateWorkflow",
        duration: 7,
        result: { success: true, content: "The workflow script compiled cleanly.", display },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const base = {
      rowId: 9,
      turnId: "turn-1",
      createdAt: 15,
      createdAtSeq: 9,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-may-set",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    expect(conversationRowSchema.parse({ ...base, display })).toMatchObject({
      display: { causalityGraph },
    });

    // 65 字符的 source 越界，整份载荷因此不被携带（不设门 = 丢卡，不是拒帧；§4.4.5）。
    const overlongSourceRow = conversationRowSchema.parse({
      ...base,
      display: {
        ...display,
        causalityGraph: {
          steps: [{ ...copy, source: "s".repeat(65) }],
          lanes: causalityGraph.lanes,
          participants: [],
          handoffs: [],
        },
      },
    });
    expect(
      overlongSourceRow.kind === "toolCall" ? overlongSourceRow.display : "unreachable",
    ).toBeUndefined();
  });

  it("accepts the phase vocabulary on both protocol boundaries", () => {
    // docs/dynamic-workflow/presentation.md: phases / phaseEdges / exits / step.phase are one all-or-nothing vocabulary.
    // The four schema layers (contracts, tool-result-metadata, v4 rows, this v3 mirror) must align field by field — if any
    // layer misses a change, a phased workflow fails whole-graph validation under .strict() and the graph vanishes entirely,
    // exactly the incident labelPattern/namePattern had on 0a8b059f40.
    const causalityGraph = {
      steps: [
        {
          id: "world-read#1",
          kind: "world-read",
          label: "glob *.ts",
          lane: "workspace",
          // Steps before the first marker land in the reserved synthetic phase.
          phase: "unphased",
        },
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          lane: "actor#1",
          phase: "phase#1",
        },
        {
          // Cross-phase copy: a site sharing a helper is claimed by both phases, `source` is the runtime site id.
          id: "ask#2~phase#1",
          kind: "ask",
          label: "bench",
          lane: "actor#2",
          source: "ask#2",
          phase: "phase#1",
        },
        {
          id: "ask#2~phase#2",
          kind: "ask",
          label: "bench",
          lane: "actor#2",
          source: "ask#2",
          phase: "phase#2",
        },
      ],
      lanes: [
        { id: "workspace" },
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "bench" },
      ],
      // Participants are carded per phase: the same subagent is one card per phase (id prefixed by the phase).
      participants: [
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2~phase#1"] },
        { id: "phase#2:actor#2", phase: "phase#2", lane: "actor#2", steps: ["ask#2~phase#2"] },
      ],
      handoffs: [
        { from: "unphased:workspace", to: "phase#1:actor#1" },
        { from: "phase#1:actor#1", to: "phase#1:actor#2", types: ["Plan"] },
      ],
      phases: [
        // `unphased` has no name (UI localizes the display); authored phases carry the original word and the first marker position.
        { id: "unphased" },
        { id: "phase#1", name: "preflight", line: 1, column: 1 },
        { id: "phase#2", name: "gate", line: 9, column: 3 },
      ],
      // Phase edges share the step-edge shape: {from, to, back?}. The back edge phase#2 → phase#1 = a loop spanning two phases.
      phaseEdges: [
        { from: "unphased", to: "phase#1" },
        { from: "phase#1", to: "phase#2" },
        { from: "phase#2", to: "phase#1", back: true },
      ],
      // Phase streams (docs/dynamic-workflow/presentation.md "Streams"): two future phases chained by a channel,
      // only {from, to} — not runs after, no back.
      phaseStreams: [{ from: "phase#1", to: "phase#2" }],
      // Phases control flow may normally finish after (the phase view's "phase → return artifact" arrows).
      exits: ["phase#2"],
      sink: ["ask#1"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_phases",
      seq: 20,
      sessionId: "sess_1",
      timestamp: 21,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_phases",
        toolName: "CreateWorkflow",
        duration: 7,
        result: { success: true, content: "The workflow script compiled cleanly.", display },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const base = {
      rowId: 10,
      turnId: "turn-1",
      createdAt: 16,
      createdAtSeq: 10,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-phases",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    expect(conversationRowSchema.parse({ ...base, display })).toMatchObject({
      display: { causalityGraph },
    });

    // v4 行上的 display 不设门（docs/v4-refactor/10-protocol-spec.md §4.4.5）：认不出来的载荷被
    // 丢掉、row 本身仍然有效，而不是把整帧拒掉。所以本 helper 断言的是「这份图被携带了」——被丢
    // 时主动抛错，好让下面每条 toThrow / not.toThrow 继续表达原来的意思。有界性没有放松：越界
    // 载荷同样到不了 UI，变的只是代价（拒整帧、连带打掉订阅 → 卡片退化成纯文本）。
    const parseWith = (graph: unknown) => {
      const row = conversationRowSchema.parse({
        ...base,
        display: { ...display, causalityGraph: graph },
      });
      if (row.kind !== "toolCall" || row.display === undefined) {
        throw new Error("v4 row dropped the create_workflow display");
      }
      return row.display;
    };

    // A script with markers but zero steps produces three arrays that are **present but empty**, and the handler passes them
    // through verbatim (no lying about truncation). The UI's view switching is "present and non-empty", so an empty vocabulary
    // must be representable on both boundaries — the arrays only have a .max() bound; any layer carelessly adding .min(1)
    // would fail whole-graph validation on that pass-through path.
    const emptyVocabulary = {
      steps: [],
      lanes: [],
      participants: [],
      handoffs: [],
      phases: [],
      phaseEdges: [],
      exits: [],
    };
    expect(() => parseWith(emptyVocabulary)).not.toThrow();
    expect(
      zcodeSessionEventSchema.parse({
        eventId: "evt_tool_workflow_phases_empty",
        seq: 21,
        sessionId: "sess_1",
        timestamp: 22,
        type: "tool.updated",
        payload: {
          kind: "result",
          toolCallId: "tool_workflow_phases_empty",
          toolName: "CreateWorkflow",
          duration: 7,
          result: {
            success: true,
            content: "ok",
            display: { ...display, causalityGraph: emptyVocabulary },
          },
        },
      }).payload,
    ).toMatchObject({ result: { display: { causalityGraph: emptyVocabulary } } });

    // 33 phases exceed the 32-phase bound; the handler degrades the whole vocabulary
    // before this boundary, so a payload this shape must be rejected outright.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phases: Array.from({ length: 33 }, (_, index) => ({ id: `phase#${index + 1}` })),
      }),
    ).toThrow();

    // 129 phase edges exceed the 128-edge bound.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseEdges: Array.from({ length: 129 }, () => ({ from: "phase#1", to: "phase#2" })),
      }),
    ).toThrow();

    // 129 phase streams exceed the same 128 bound; a stream carries no `back` and no kind.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseStreams: Array.from({ length: 129 }, () => ({ from: "phase#1", to: "phase#2" })),
      }),
    ).toThrow();
    for (const stream of [
      { from: "phase#1", to: "phase#2", back: true },
      { from: "phase#1", to: "phase#2", kind: "data" },
    ]) {
      expect(() => parseWith({ ...causalityGraph, phaseStreams: [stream] })).toThrow();
    }

    // 33 exits exceed the 32-phase bound (exits share the phase table's bound).
    expect(() =>
      parseWith({
        ...causalityGraph,
        exits: Array.from({ length: 33 }, (_, index) => `phase#${index + 1}`),
      }),
    ).toThrow();

    // Phase edges share the step-edge shape: none of the analyzer's kind / certainty / exact enters the payload.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseEdges: [
          { from: "phase#1", to: "phase#2", kind: "seq", certainty: "maybe", exact: true },
        ],
      }),
    ).toThrow();
  });

  it("gives the same verdict on the single-arrow shape on both protocol boundaries", () => {
    // docs/dynamic-workflow/presentation.md: hard cut — the old shapes (edges with kind /
    // certainty / exact, steps with region / certainty, lanes with families, top-level regions) are rejected **simultaneously**
    // on both v3 / v4 mirrors; the new shapes ({from, to, back?}, participants + handoffs, exits) pass simultaneously.
    // docs/dynamic-workflow/presentation.md also removed step-level `edges` and `Lane.nesting`; both are pinned here as same-verdict.
    // A missed layer would let the same payload pass on one boundary while the whole graph vanishes on the other. The third copy
    // (contracts) is not in this package's dependency graph; contracts' own create-workflow.test.ts pins it with the same samples.
    const eventOf = (causalityGraph: unknown) => ({
      eventId: "evt_tool_workflow_single_arrow",
      seq: 22,
      sessionId: "sess_1",
      timestamp: 23,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_single_arrow",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: true,
          content: "ok",
          display: {
            kind: "create_workflow",
            ok: true,
            errorCount: 0,
            diagnostics: [],
            causalityGraph,
          },
        },
      },
    });
    const rowOf = (causalityGraph: unknown) => ({
      rowId: 11,
      turnId: "turn-1",
      createdAt: 17,
      createdAtSeq: 11,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-single-arrow",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph,
      },
    });
    // The second verdict asks "did the v4 row **carry** this graph", not "did the row parse": with display ungated an
    // unreadable payload is dropped while the row stays valid, so asking by success would turn every negative case true (§4.4.5).
    const verdicts = (causalityGraph: unknown) => {
      const row = conversationRowSchema.safeParse(rowOf(causalityGraph));
      return [
        zcodeSessionEventSchema.safeParse(eventOf(causalityGraph)).success,
        row.success && row.data.kind === "toolCall" && row.data.display !== undefined,
      ];
    };

    const fresh = {
      steps: [
        { id: "ask#1", kind: "ask", label: "planner", lane: "actor#1", phase: "phase#1" },
        { id: "ask#2", kind: "ask", label: "reviewer", lane: "actor#2", phase: "phase#2" },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "reviewer" },
      ],
      participants: [
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        {
          id: "phase#2:actor#2[0]",
          phase: "phase#2",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 0, of: 2 },
        },
        {
          id: "phase#2:actor#2[1]",
          phase: "phase#2",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 1, of: 2 },
        },
      ],
      handoffs: [
        { from: "phase#1:actor#1", to: "phase#2:actor#2[0]", types: ["Plan"] },
        { from: "phase#1:actor#1", to: "phase#2:actor#2[1]", types: ["Plan"] },
        { from: "phase#2:actor#2[0]", to: "phase#1:actor#1", back: true },
      ],
      phases: [
        { id: "phase#1", name: "plan" },
        { id: "phase#2", name: "review" },
      ],
      phaseEdges: [
        { from: "phase#1", to: "phase#2" },
        { from: "phase#2", to: "phase#1", back: true },
      ],
      exits: ["phase#2"],
      sink: ["ask#2"],
    };
    expect(verdicts(fresh)).toEqual([true, true]);

    const legacy = {
      steps: [
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          lane: "actor#1",
          region: "seq#1",
          certainty: "always",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "reviewer",
          lane: "actor#2",
          region: "loop#1",
          certainty: "maybe",
        },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "reviewer", families: ["loop#1"] },
      ],
      regions: [
        { id: "seq#1", kind: "seq" },
        { id: "loop#1", kind: "loop", parent: "seq#1" },
      ],
      edges: [
        { from: "ask#1", to: "ask#2", kind: "data", certainty: "always", exact: true },
        { from: "ask#2", to: "ask#1", kind: "carry", certainty: "maybe" },
      ],
      sink: ["ask#2"],
    };
    expect(verdicts(legacy)).toEqual([false, false]);

    // Each legacy field is rejected individually too — not just the full legacy payload.
    const [freshStep] = fresh.steps;
    const [freshLane] = fresh.lanes;
    const [freshParticipant] = fresh.participants;
    const [freshHandoff] = fresh.handoffs;
    const { participants: _p, ...noParticipants } = fresh;
    const { handoffs: _h, ...noHandoffs } = fresh;
    for (const graph of [
      { ...fresh, steps: [{ ...freshStep, region: "seq#1" }, fresh.steps[1]] },
      { ...fresh, steps: [{ ...freshStep, certainty: "always" }, fresh.steps[1]] },
      { ...fresh, lanes: [{ ...freshLane, families: ["loop#1"] }, fresh.lanes[1]] },
      { ...fresh, lanes: [freshLane, { ...fresh.lanes[1], nesting: 2 }] },
      { ...fresh, regions: [] },
      // step-level edges is gone as a whole field.
      { ...fresh, edges: [] },
      { ...fresh, edges: [{ from: "ask#1", to: "ask#2" }] },
      // Participants / handoffs required, strict, bounded.
      noParticipants,
      noHandoffs,
      {
        ...fresh,
        participants: [{ ...freshParticipant, steps: [] }, ...fresh.participants.slice(1)],
      },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: -1, of: 2 } }] },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: 0, of: 0 } }] },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: 0 } }] },
      { ...fresh, participants: [{ ...freshParticipant, many: false }] },
      { ...fresh, participants: [{ ...freshParticipant, name: "planner" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, kind: "data" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, certainty: "always" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, exact: true }] },
      { ...fresh, handoffs: [{ ...freshHandoff, back: false }] },
      { ...fresh, handoffs: [{ ...freshHandoff, types: [] }] },
      {
        ...fresh,
        handoffs: [{ ...freshHandoff, types: Array.from({ length: 9 }, (_, i) => `T${i}`) }],
      },
      { ...fresh, handoffs: [{ ...freshHandoff, types: ["t".repeat(129)] }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", kind: "seq" }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", back: "yes" }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", types: ["Plan"] }] },
    ]) {
      expect(verdicts(graph)).toEqual([false, false]);
    }
    // Legal variants of the new fields pass on both boundaries simultaneously.
    for (const graph of [
      {
        ...fresh,
        participants: [{ ...freshParticipant, many: true }, ...fresh.participants.slice(1)],
      },
      {
        ...fresh,
        handoffs: [{ ...freshHandoff, types: Array.from({ length: 8 }, (_, i) => `T${i}`) }],
      },
      { ...fresh, participants: [], handoffs: [] },
    ]) {
      expect(verdicts(graph)).toEqual([true, true]);
    }
  });

  it("parses replayable session event batches", () => {
    const batch = zcodeSessionEventsResultSchema.parse({
      events: [
        {
          eventId: "evt_turn_1",
          seq: 1,
          sessionId: "sess_1",
          timestamp: 2,
          deliveryKind: "web-remote-replayable",
          type: "turn.started",
          payload: {
            inputId: "t-sess_1-run",
            input: "hello",
            turnNumber: 1,
          },
        },
      ],
    });

    expect(batch.events[0]?.deliveryKind).toBe("web-remote-replayable");
    expect(batch.events[0]?.payload).toMatchObject({ inputId: "t-sess_1-run" });
  });

  it.each([undefined, "desktop-continuous", "web-remote-replayable"])(
    "accepts the complete runtime turn.started payload (%s)",
    (deliveryKind) => {
      const event = zcodeSessionEventSchema.parse({
        eventId: "evt_turn_runtime",
        seq: 2,
        sessionId: "sess_1",
        turnId: "turn_1",
        timestamp: 3,
        deliveryKind,
        type: "turn.started",
        payload: {
          turnNumber: 2,
          executionStartedAt: 1789614547807.125,
          input: "hello",
          messageId: "msg_1",
          foregroundExecutionId: "foreground_1",
          backgroundSource: "subagent",
          intent: {
            sourceCommandId: "command_1",
            queueItemId: "queue_1",
            clientId: "bot",
            kind: "sendText",
          },
          originMeta: { source: "bot" },
          attachments: [{ name: "fixture.txt", mediaType: "text/plain" }],
        },
      });

      expect(event.payload).toMatchObject({
        executionStartedAt: 1789614547807.125,
        messageId: "msg_1",
        foregroundExecutionId: "foreground_1",
        backgroundSource: "subagent",
        intent: expect.objectContaining({ sourceCommandId: "command_1" }),
      });
    },
  );

  it("parses subagent message model-only inputs for replayable delivery", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_response",
      seq: 2,
      sessionId: "sess_1",
      timestamp: 3,
      deliveryKind: "web-remote-replayable",
      type: "turn.started",
      payload: {
        inputId: "turn_subagent_response",
        input: "<subagent-message>progress</subagent-message>",
        inputSource: "subagent_message",
        inputVisibility: "model-only",
        turnNumber: 2,
      },
    });

    expect(event.payload).toMatchObject({
      inputSource: "subagent_message",
      inputVisibility: "model-only",
    });
  });

  it("parses persisted model-only subagent messages across the app/agent boundary", () => {
    const message = zcodeUserMessageInfoSchema.parse({
      messageId: "msg_subagent_response",
      sessionId: "sess_1",
      role: "user",
      time: { created: 3 },
      agent: "zcode-agent",
      model,
      source: "subagent_message",
      visibility: "model-only",
    });

    expect(message.source).toBe("subagent_message");
  });

  it("parses strict workspace interaction preference updates", () => {
    expect(
      zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse({
        workspace,
        preferences: {
          askUserQuestionAutoResolutionEnabled: false,
        },
      }),
    ).toEqual({
      workspace,
      preferences: {
        askUserQuestionAutoResolutionEnabled: false,
      },
    });
    expect(
      zcodeWorkspaceUpdateInteractionPreferencesResultSchema.parse({
        workspace,
        askUserQuestionAutoResolutionEnabled: false,
        snoozedInteractionCount: 2,
      }),
    ).toMatchObject({
      askUserQuestionAutoResolutionEnabled: false,
      snoozedInteractionCount: 2,
    });
    expect(() =>
      zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse({
        workspace,
        preferences: {
          askUserQuestionAutoResolutionEnabled: false,
          ignored: true,
        },
      }),
    ).toThrow();
  });

  it("parses strict workspace ModelIO retention preference updates", () => {
    expect(
      zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse({
        workspace,
        preferences: { fullRetentionEnabled: true },
      }),
    ).toEqual({
      workspace,
      preferences: { fullRetentionEnabled: true },
    });
    expect(
      zcodeWorkspaceUpdateModelIoPreferencesResultSchema.parse({
        workspace,
        fullRetentionEnabled: true,
        updatedSessionCount: 2,
      }),
    ).toMatchObject({
      fullRetentionEnabled: true,
      updatedSessionCount: 2,
    });
    expect(() =>
      zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse({
        workspace,
        preferences: { fullRetentionEnabled: true, ignored: true },
      }),
    ).toThrow();
  });

  it("validates ToolSearch startup preferences and defaults old Host responses off", () => {
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({ nativeSearchEnhancementsEnabled: true })
        .toolSearchMode,
    ).toBe("off");
    for (const mode of ["auto", "local", "off"]) {
      expect(
        zcodeSessionRuntimePreferencesResultSchema.parse({
          nativeSearchEnhancementsEnabled: true,
          toolSearchMode: mode,
        }).toolSearchMode,
      ).toBe(mode);
    }
    expect(
      zcodeSessionRuntimePreferencesResultSchema.safeParse({
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "native",
      }).success,
    ).toBe(false);
  });

  it("keeps runtime preference compatibility by defaulting missing fields", () => {
    expect(DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY).toBe("preflight-v1");
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
      }),
    ).toMatchObject({
      askUserQuestionAutoResolutionEnabled: true,
      memoryEnabled: false,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
        askUserQuestionAutoResolutionEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      }).askUserQuestionAutoResolutionEnabled,
    ).toBe(false);
    expect(() =>
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
        modelContextBudgetStrategy: "unknown",
      }),
    ).toThrow();
  });

  it("accepts turn.completed cache stats and history round count from runtime events", () => {
    const event = zcodeSessionEventSchema.parse({
      type: "turn.completed",
      eventId: "evt_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 2,
      traceId: "trace_1",
      timestamp: Date.now(),
      deliveryKind: "desktop-continuous",
      payload: {
        response: "ok",
        tokenCount: 2,
        toolCallCount: 0,
        historyRoundCount: 3,
        duration: 123,
        resultType: "success",
        inputId: "run_1",
        cacheStats: {
          totalMessages: 4,
          cachedMessages: 2,
          lastCacheHit: true,
          cacheReadTokens: 128,
        },
      },
    });

    expect(event.payload.cacheStats).toMatchObject({
      cachedMessages: 2,
      lastCacheHit: true,
    });
    expect(event.payload.historyRoundCount).toBe(3);
  });

  it("parses state.updated notifications as the core state sync primitive", () => {
    const event = zcodeStateUpdatedNotificationSchema.parse({
      type: "state.updated",
      scope: "session",
      workspace,
      sessionId: "sess_1",
      revision: 4,
      reason: "model_changed",
      patch: {
        settings: {
          model: {
            current: model,
          },
        },
      },
    });

    expect(event.revision).toBe(4);
  });

  it("workspace presentation rejects model facts", () => {
    expect(() =>
      zcodeWorkspacePresentationSchema.parse({
        workspace,
        mode: "build",
        slashCommands: [],
        model,
      }),
    ).toThrow();
  });
});

describe("v4 workflowLaunch rows (direct-launch)", () => {
  const meta = {
    runId: "run-123",
    toolCallId: "launch-abc",
    name: "deep-research",
    scope: "global" as const,
    path: "/home/u/.zcode/workflows/deep-research.ts",
    args: { topic: "adaptive concurrency", depth: 2 },
    description: "Deep-dive a topic across the web and write a brief.",
  };

  it("parses a turnHeader row with origin workflowLaunch + meta", () => {
    const row = conversationRowSchema.parse({
      rowId: 1,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "workflowLaunch",
      executionKind: "controlOnly",
      state: "running",
      startedAt: 10,
      workflowLaunch: meta,
    });
    expect(row).toMatchObject({
      kind: "turnHeader",
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
  });

  it("parses a userInput row with origin workflowLaunch + meta (text still carried)", () => {
    const row = conversationRowSchema.parse({
      rowId: 2,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 2,
      kind: "userInput",
      text: 'Started the saved workflow "deep-research" (global) from the workflows hub as run run-123.',
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
    expect(row).toMatchObject({
      kind: "userInput",
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
  });

  it("rejects a description over the 500-char bound", () => {
    expect(
      workflowLaunchMetaSchema.safeParse({ ...meta, description: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      workflowLaunchMetaSchema.safeParse({ ...meta, description: "x".repeat(500) }).success,
    ).toBe(true);
  });

  it("rejects an args payload over the 4KB serialized bound", () => {
    const bigArgs = { blob: "x".repeat(5000) };
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, args: bigArgs }).success).toBe(false);
  });

  it("rejects meta with missing runId or bad scope", () => {
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, runId: "" }).success).toBe(false);
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, scope: "team" }).success).toBe(false);
  });

  // The settings turn (docs/dynamic-workflow/launch.md "The settings turn"): the same metadata with no save file to point
  // at, plus an `amend` block saying what changed.
  it("parses a settings-turn meta: no scope or path, an amend block with from/to ends", () => {
    const settings = {
      runId: "run-b",
      toolCallId: "settings-abc",
      name: "deep-research",
      amend: {
        predecessorRunId: "run-a",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    };
    expect(workflowLaunchMetaSchema.parse(settings)).toEqual(settings);
    // An unnamed run's settings turn carries no name (the UI falls back to a stock label rather than using the run id as a title).
    const { name: _name, ...unnamed } = settings;
    void _name;
    expect(workflowLaunchMetaSchema.parse(unnamed)).toEqual(unnamed);
    expect(
      workflowLaunchMetaSchema.safeParse({
        ...settings,
        amend: { ...settings.amend, maxConcurrency: { to: 0 } },
      }).success,
    ).toBe(false);
    expect(
      workflowLaunchMetaSchema.safeParse({ ...settings, amend: { predecessorRunId: "" } }).success,
    ).toBe(false);
  });

  // In-place settings turn (docs/dynamic-workflow/concurrency.md): only the concurrency cap changed and the run is still in
  // flight, so there is no predecessor — `predecessorRunId` is therefore absent, and absence itself is the signal "the run being
  // changed is this runId" (the renderer emits one row based on it).
  it("parses an in-place retune's settings-turn meta: no predecessorRunId at all", () => {
    const retune = {
      runId: "run-a",
      toolCallId: "settings-xyz",
      name: "deep-research",
      amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 },
    };
    expect(workflowLaunchMetaSchema.parse(retune)).toEqual(retune);
    // When present it must still be a real run id: optional does not mean nullable, nor an empty string.
    expect(
      workflowLaunchMetaSchema.safeParse({
        ...retune,
        amend: { ...retune.amend, predecessorRunId: null },
      }).success,
    ).toBe(false);
  });
});

describe("provider rate limits (ChatGPT plan usage transport)", () => {
  const legacyResult = {
    text: "ok",
    selection: model,
    finishReason: "stop",
    usage: { inputTokens: 3, outputTokens: 256, totalTokens: 259 },
  };

  it("keeps accepting pre-usage generateText results (additive field)", () => {
    expect(zcodeWorkspaceGenerateTextResultSchema.parse(legacyResult)).toEqual(legacyResult);
    expect(
      zcodeWorkspaceGenerateTextResultSchema.safeParse({ ...legacyResult, usage: undefined })
        .success,
    ).toBe(true);
  });

  it("accepts results carrying providerRateLimits", () => {
    const withUsage = {
      ...legacyResult,
      usage: {
        ...legacyResult.usage,
        providerRateLimits: {
          primary: {
            usedPercent: 42.5,
            windowMinutes: 300,
            resetsAt: "2026-10-15T18:00:00Z",
          },
          secondary: { usedPercent: 7 },
        },
      },
    };
    expect(zcodeWorkspaceGenerateTextResultSchema.parse(withUsage)).toEqual(withUsage);
  });

  it("validates the window shape strictly", () => {
    expect(zcodeProviderRateLimitsSchema.safeParse({}).success).toBe(false);
    // primary is required; secondary-only is not a snapshot.
    expect(
      zcodeProviderRateLimitsSchema.safeParse({ primary: undefined, secondary: { usedPercent: 1 } })
        .success,
    ).toBe(false);
    // usedPercent bounds.
    expect(zcodeProviderRateLimitsSchema.safeParse({ primary: { usedPercent: 140 } }).success).toBe(
      false,
    );
    expect(zcodeProviderRateLimitsSchema.safeParse({ primary: { usedPercent: -1 } }).success).toBe(
      false,
    );
    // window-minutes is a positive integer; resetsAt stays a string.
    expect(
      zcodeProviderRateLimitsSchema.safeParse({ primary: { usedPercent: 1, windowMinutes: 0 } })
        .success,
    ).toBe(false);
    expect(
      zcodeProviderRateLimitsSchema.safeParse({ primary: { usedPercent: 1, resetsAt: 42 } })
        .success,
    ).toBe(false);
    // Unknown members are rejected (strict).
    expect(
      zcodeProviderRateLimitsSchema.safeParse({ primary: { usedPercent: 1, extra: true } }).success,
    ).toBe(false);
  });
});
