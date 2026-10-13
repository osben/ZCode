// Legacy v3 boundary: newly added ask preview fields must not leak into the strict schema.
import { describe, expect, it } from "vitest";
import {
  EventReducer,
  SessionEventType,
  createSessionEvent,
  type EventId,
  type SessionEvent,
  type SessionId,
  type ToolCallId,
  type TraceId,
} from "@zcode/contracts";
import { zcodeSessionEventSchema, zcodeSessionProjectionSchema } from "@zcode/shared";
import {
  mapSessionEvent,
  mapSessionProjection,
  shouldExposeSessionEventToProtocol,
} from "../src/zcode-protocol/session-mapper.js";

function permissionRequestedEvent(payload: Record<string, unknown>): SessionEvent {
  return {
    id: "legacy-permission-event" as EventId,
    sessionId: "legacy-session" as SessionId,
    type: SessionEventType.PermissionRequested,
    timestamp: new Date(1_700_000_000_000),
    traceId: "legacy-trace" as TraceId,
    sequenceNumber: 1,
    payload,
  };
}

describe("legacy permission.requested 映射", () => {
  const basePayload = {
    requestId: "req-1",
    toolCallId: "tc-1" as ToolCallId,
    toolName: "CreateWorkflow",
    riskLevel: "low",
    reason: "createWorkflow.runConfirmation",
    input: { script: "return 1;" },
  };

  it("剥离 ask 预览，映射结果仍能过 strict schema", () => {
    // zcodePermissionRequestedEventPayloadSchema is .strict(), while the app side parses received events with
    // safeParse: one extra unknown field makes it drop the entire event, and the confirmation window never reaches the old app.
    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
    );

    const parsed = zcodeSessionEventSchema.safeParse(mapped);
    expect(parsed.success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("display");
    expect(mapped.payload).not.toHaveProperty("optionsPolicy");
  });

  /**
   * Why the reusable workflow's normalized input holds on legacy v3 (the spec's "version skew boundary").
   *
   * This pins the whole "input channel" decision: a saved run's script travels in `input`, and the legacy side's
   * `input` is `z.unknown()` (zcode-protocol/index.ts) — so the old client receiving the complete script
   * **is not a compatibility shim; it holds by construction**. By contrast, putting the script into display would
   * be wiped wholesale by the stripping logic above, and the saved run would be approved on a window that shows no code at all.
   */
  it("saved run 的归一化入参整份过 strict schema，脚本不被剥离", () => {
    const normalizedInput = {
      name: "nightly",
      script:
        'interface R { done: boolean }\nconst r = await agent("w").ask<R>("do");\nreturn r.done;',
      saved: {
        name: "nightly",
        args: { depth: 3, target: "packages/core" },
        path: "/repo/.zcode/workflows/nightly.dwf.ts",
        scope: "project",
      },
    };

    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        input: normalizedInput,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    // display is stripped as usual (legacy gets no graph), but not one input field is lost — so the old desktop's
    // readWorkflowScript(raw.script) / readWorkflowName(raw.name) both hit.
    expect(mapped.payload).not.toHaveProperty("display");
    expect((mapped.payload as { input: unknown }).input).toEqual(normalizedInput);
  });

  /**
   * The same argument for SaveWorkflow on legacy v3: v1 deliberately adds no `save_workflow` display kind,
   * so the old client receives the generic permission prompt plus the **complete** input JSON (target, overwrite decision, script all included).
   */
  it("SaveWorkflow 的归一化入参同样整份过 strict schema", () => {
    const normalizedInput = {
      name: "pr-review",
      description: "Review a pull request",
      script: "return 1;",
      path: "/repo/.zcode/workflows/pr-review.dwf.ts",
      overwrite: true,
      scope: "project",
    };

    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: normalizedInput,
        optionsPolicy: "no-always-allow",
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect((mapped.payload as { input: unknown }).input).toEqual(normalizedInput);
  });

  it("仍按策略把选项收窄成允许一次 + 拒绝", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, optionsPolicy: "no-always-allow" }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    // Tripwire (docs/dynamic-workflow/launch.md "Refine"): Refine is only synthesized in the v4 projection and
    // deliberately absent from the legacy option list — the old desktop has no textarea, so picking it would just be a dumb denial.
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });

  // Round 7: session-free confirmation is only offered in v4. What the old desktop sends back is the raw response
  // and it cannot recognize session semantics; offering it would only yield a mislabeled "allow once" — legacy demotes the policy to no-always-allow.
  it("session-always-allow 在 legacy 上降为允许一次 + 拒绝，且过 strict schema", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, optionsPolicy: "session-always-allow" }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("optionsPolicy");
    const options = (mapped.payload as { options: { optionId: string; kind: string }[] })
      .options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    expect(options.some((option) => option.kind === "allow_session")).toBe(false);
  });

  it("未声明策略的工具保持默认三个选项", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, toolName: "Bash", input: { command: "ls" } }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "allow_project",
      "deny",
    ]);
  });

  /**
   * SaveWorkflow takes the same narrowing: its `askOptions.allowAlways: false` (core's tool declaration)
   * becomes `optionsPolicy: "no-always-allow"` via the approval gate and travels with the event (invariant 3).
   *
   * "No always allow" is not aesthetics here: what is written into the repo will be committed, seen by others,
   * and run again later; a persistent project rule cannot remember "this one decision" — it would only turn this confirmation off permanently.
   */
  it("SaveWorkflow 同样收窄成允许一次 + 拒绝，且不含 workflowRefine", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: {
          name: "pr-review",
          description: "Review a pull request",
          script: "return 1;",
          path: "/repo/.zcode/workflows/pr-review.dwf.ts",
          overwrite: true,
          scope: "project",
        },
        optionsPolicy: "no-always-allow",
      }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    // The same tripwire, applied to the save window: Refine is only synthesized in the v4 projection, and the legacy list contains it for neither tool.
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });

  // This is the "next person adds a field to the spread" tripwire: after a permission_requested carrying display
  // goes through reducer pick → PendingPermission → mapPendingPermission, the result must pass both
  // zcodePermissionRequestedEventPayloadSchema and zcodePendingPermissionSchema, two strict schemas. If stripping is
  // missed at either point, this goes red.
  it("带 display 的请求经两个 legacy mapper 后同时通过两个 strict schema", () => {
    const sessionId = "legacy-session" as SessionId;
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: {
        steps: [
          {
            id: "ask#1",
            kind: "ask",
            label: "a",
            line: 2,
            column: 11,
            lane: "actor#1",
          },
        ],
        lanes: [{ id: "actor#1", name: "a" }],
        // The second layer is subagent-oriented: one participant card per phase + handoff edges (docs/dynamic-workflow/presentation.md).
        participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
        handoffs: [],
        sink: ["ask#1"],
      },
    };
    const askPayload = { ...basePayload, display, optionsPolicy: "no-always-allow" };

    // The event channel.
    const mappedEvent = mapSessionEvent(permissionRequestedEvent(askPayload));
    expect(zcodeSessionEventSchema.safeParse(mappedEvent).success).toBe(true);

    // The snapshot channel: first let the reducer really take the display into PendingPermission, then apply the legacy mapping.
    const projection = new EventReducer().reduce([
      createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200_000,
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, askPayload),
    ]);
    expect(projection.pendingPermissions[0]?.display).toEqual(display);

    const mappedProjection = mapSessionProjection(projection);
    const parsedProjection = zcodeSessionProjectionSchema.safeParse(mappedProjection);
    expect(parsedProjection.success).toBe(true);
    const pending = mappedProjection.pendingPermissions[0]!;
    expect(pending).not.toHaveProperty("display");
    expect(pending).not.toHaveProperty("optionsPolicy");
    // The policy's effect still lands: what crosses the protocol is the two-item list with allow_always already cut.
    expect(pending.options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
  });

  /**
   * The **snapshot channel** for normalized input: the two saved / SaveWorkflow assertions above go through the
   * event channel (mapSessionEvent), while a cold-started old client reads pendingPermissions from the projection.
   * Each channel has its own strict schema; if either narrows input into a structured shape, the script vanishes at that surface.
   */
  it("两个工具的归一化入参在快照通道上同样整份存活", () => {
    const sessionId = "legacy-session" as SessionId;
    const savedRunInput = {
      name: "release-check",
      script: 'return await agent("检查员").ask<string>("检查一遍");',
      saved: {
        name: "release-check",
        args: { target: "packages/core", depth: 3, skipTests: false },
        path: "/repo/.zcode/workflows/release-check.dwf.ts",
        scope: "project",
      },
    };
    const saveInput = {
      name: "release-check",
      description: "对本仓库做一次发布前检查",
      script: "return 1;",
      path: "/repo/.zcode/workflows/release-check.dwf.ts",
      overwrite: true,
      scope: "project",
    };

    const projection = new EventReducer().reduce([
      createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200_000,
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
        ...basePayload,
        input: savedRunInput,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
        ...basePayload,
        requestId: "req-2",
        toolCallId: "tc-2" as ToolCallId,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: saveInput,
        optionsPolicy: "no-always-allow",
      }),
    ]);

    const mapped = mapSessionProjection(projection);
    expect(zcodeSessionProjectionSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.pendingPermissions.map((pending) => pending.input)).toEqual([
      savedRunInput,
      saveInput,
    ]);
    for (const pending of mapped.pendingPermissions) {
      expect(pending).not.toHaveProperty("display");
      expect(pending.options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    }
  });
});

// Legacy v3 boundary: dwf run progress events are stripped at the protocol boundary (same seam and same reason as
// StreamingToolLedgerUpdated). See docs/dynamic-workflow/presentation.md "The run state the pane draws".
describe("legacy v3 剥离 dwf run 进度事件", () => {
  function runProgressEvent(): SessionEvent {
    return {
      id: "dwf-progress-event" as EventId,
      sessionId: "legacy-session" as SessionId,
      type: SessionEventType.DynamicWorkflowRunProgress,
      timestamp: new Date(1_700_000_000_000),
      traceId: "legacy-trace" as TraceId,
      sequenceNumber: 3,
      payload: {
        runId: "dwfrun-1",
        toolCallId: "tc-1" as ToolCallId,
        sequence: 5,
        eventType: "node-settled",
        payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
      },
    };
  }

  it("不透出到 v3 协议流", () => {
    // The strip is **not** about preventing event loss: mapSessionEventType's default falls through to session.updated,
    // and that envelope's payload is the lenient jsonObjectSchema, so the old desktop could absorb it anyway.
    // The reason for stripping is bandwidth and semantic cleanliness — the v4 side already has the authoritative
    // projection (workflowRuns) and the v3 mapper does not consume it.
    expect(shouldExposeSessionEventToProtocol(runProgressEvent())).toBe(false);
  });

  it("与 StreamingToolLedgerUpdated 同一个判定，且不影响其它事件", () => {
    expect(
      shouldExposeSessionEventToProtocol({
        ...runProgressEvent(),
        type: SessionEventType.StreamingToolLedgerUpdated,
      }),
    ).toBe(false);
    expect(
      shouldExposeSessionEventToProtocol({
        ...runProgressEvent(),
        type: SessionEventType.BackgroundTaskStarted,
      }),
    ).toBe(true);
  });

  it("万一被透出，映射结果仍过 strict schema（v3 侧没有状态键要剥）", () => {
    // This is the "next person removes the strip" tripwire: even if the strip disappeared, the mapped result must not make the old desktop drop the entire event.
    const mapped = mapSessionEvent(runProgressEvent());
    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    // v3's zcodeSessionProjectionSchema is .strict() and has no state surface such as subagents at all,
    // so there is no counterpart of "strip workflowRuns in the legacy mapping".
    expect(
      zcodeSessionProjectionSchema.safeParse(
        mapSessionProjection(
          new EventReducer().reduce([
            createSessionEvent(SessionEventType.SessionCreated, "legacy-session" as SessionId, {
              mode: "build",
              contextWindow: 200_000,
            }),
            runProgressEvent(),
          ]),
        ),
      ).success,
    ).toBe(true);
  });
});
