// The boundaries of the reusable workflow's two confirmation windows on the v4 projection
// (docs/dynamic-workflow/launch.md).
//
// The whole file pins the same decision: the saved run's script and SaveWorkflow's destination/overwrite
// decision all go through the **normalized input**, with display gaining not a single field. The reason for
// choosing it over display is in the spec's "version skew boundary": the input channel is schema-less pass-through
// for every client version (`detail: z.unknown()` on the v4 side, `input: z.unknown()` on the legacy v3 side),
// whereas new fields on display are invisible to old clients — a saved run would get approved on a window that
// shows no code at all, breaking invariant 1 "saving produces no trust" on the spot.
import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { builtInTools } from "@zcode/core";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

// ── Event sequence builders (same shape as product-projection.test.ts) ──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: SessionEventTypeUnion, payload: unknown, turnId = "turn-1"): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function project(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

/** The permission payload of pendingInteractions[0]; anything non-permission fails directly, so optional chaining can't swallow the assertion. */
function permissionPayload(projection: ProductProjection) {
  const payload = projection.getSnapshot().pendingInteractions[0]?.payload;
  expect(payload?.kind).toBe("permission");
  if (payload?.kind !== "permission") throw new Error("unreachable");
  return payload;
}

function gateEvents(options: {
  toolName: string;
  input: unknown;
  reason: string;
  display?: unknown;
  optionsPolicy?: string;
}): SessionEvent[] {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
  log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run it" });
  log.push(SessionEventType.ToolCallScheduled, {
    toolCallId: "tc-1",
    toolName: options.toolName,
    input: options.input,
    schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
  });
  log.push(SessionEventType.PermissionRequested, {
    requestId: "req-1",
    toolCallId: "tc-1",
    toolName: options.toolName,
    riskLevel: "low",
    reason: options.reason,
    input: options.input,
    ...(options.optionsPolicy === undefined ? {} : { optionsPolicy: options.optionsPolicy }),
    ...(options.display === undefined ? {} : { display: options.display }),
  });
  return log.events;
}

// ── Fixtures: each tool's **normalized** input (the one produced by the executor's resolveInput) ──

const SCRIPT = 'const r = agent("检查员");\nreturn await r.ask<string>("检查一遍");';

/** CreateWorkflow saved source: `{name, script, saved:{name, args, path, scope}}`. */
const SAVED_RUN_INPUT = {
  name: "release-check",
  script: SCRIPT,
  saved: {
    name: "release-check",
    // All four declared types go in: the argument bag must pass through the protocol whole, not just the
    // strings surviving.
    args: {
      target: "packages/core",
      depth: 3,
      skipTests: false,
      matrix: { os: ["mac", "win"], strict: true },
    },
    path: "/repo/.zcode/workflows/release-check.dwf.ts",
    scope: "project",
  },
};

/** Inline source: the same script, with `saved` absent. The two paths' gates must differ by exactly this one key. */
const INLINE_RUN_INPUT = { name: "release-check", script: SCRIPT };

const WORKFLOW_DISPLAY = {
  kind: "create_workflow",
  ok: true,
  errorCount: 0,
  diagnostics: [],
  causalityGraph: {
    steps: [
      {
        id: "ask#1",
        kind: "ask",
        label: "检查员",
        line: 2,
        column: 14,
        lane: "actor#1",
      },
    ],
    lanes: [{ id: "actor#1", name: "检查员" }],
    // The second layer is subagent-oriented: one participant card per phase + handoff edges
    // (docs/dynamic-workflow/presentation.md).
    participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
    handoffs: [],
    sink: ["ask#1"],
  },
};

/** SaveWorkflow: `{name, description, whenToUse?, args?, script, path, overwrite, scope}`. */
const SAVE_INPUT = {
  name: "release-check",
  description: "对本仓库做一次发布前检查",
  whenToUse: "用户说要发版时",
  args: { target: { type: "string", required: true, description: "要检查的包" } },
  script: SCRIPT,
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  overwrite: true,
  scope: "project",
};

/**
 * SaveWorkflow's optionsPolicy is **derived from the real core tool declaration**, not hardcoded in the
 * fixture.
 * The derivation is verbatim identical to approval-gate.ts (`askOptions.allowAlways === false` ⇒
 * no-always-allow):
 * if someone flips SaveWorkflow's allowAlways to true, the "no always allow" assertion below goes red
 * immediately instead of staying green while asserting a payload that no longer occurs.
 */
const saveWorkflowEntry = builtInTools.find(
  (entry) => entry.metadata.name === SAVE_WORKFLOW_TOOL_NAME,
);
const saveWorkflowOptionsPolicy =
  saveWorkflowEntry?.permission?.askOptions?.allowAlways === false ? "no-always-allow" : undefined;

describe("saved 源 CreateWorkflow 的确认窗（v4 投影）", () => {
  function savedGate(): ProductProjection {
    return project(
      gateEvents({
        toolName: CREATE_WORKFLOW_TOOL_NAME,
        input: SAVED_RUN_INPUT,
        reason: "createWorkflow.runConfirmation",
        display: WORKFLOW_DISPLAY,
        optionsPolicy: "no-always-allow",
      }),
    );
  }

  it("归一化入参整份进 detail：解析出的脚本与 saved 来龙去脉都在", () => {
    const payload = permissionPayload(savedGate());

    // Verbatim equality, not "contains": the confirmation window shows exactly the facts that will run; one
    // extra or missing key is
    // the beginning of "approve A, run B" (invariant 5).
    expect(payload.detail).toEqual(SAVED_RUN_INPUT);
    expect(payload.toolName).toBe(CREATE_WORKFLOW_TOOL_NAME);
    const detail = payload.detail as typeof SAVED_RUN_INPUT;
    // The legacy desktop's existing read rules (readWorkflowScript(raw.script) / readWorkflowName(raw.name))
    // therefore hit **by construction** — not as a compatibility shim.
    expect(detail.script).toBe(SCRIPT);
    expect(detail.name).toBe("release-check");
    expect(detail.saved).toEqual(SAVED_RUN_INPUT.saved);
  });

  it("四种类型的实参整份穿过 v4 快照 schema（detail 是 z.unknown() 的透传）", () => {
    const snapshot = savedGate().getSnapshot();
    const parsed = conversationSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);

    // Read once more from the parse product: proving that "what survived" is the schema-approved copy, not just
    // the in-memory object.
    const roundTripped = parsed.success ? parsed.data.pendingInteractions[0]?.payload : undefined;
    expect(roundTripped?.kind === "permission" && roundTripped.detail).toEqual(SAVED_RUN_INPUT);
  });

  it("Refine 选项按 toolName 合成：saved 与内联两条路径的选项列表逐字相同", () => {
    // This is the tripwire against "the next person changes Refine synthesis to judge by input shape". The
    // synthesis only respects
    // toolName === CreateWorkflow; if someone changes it to "only inline scripts get Refine",
    // saved-run users would lose the only channel to send their revision feedback back.
    const savedOptions = permissionPayload(savedGate()).options;
    const inlineOptions = permissionPayload(
      project(
        gateEvents({
          toolName: CREATE_WORKFLOW_TOOL_NAME,
          input: INLINE_RUN_INPUT,
          reason: "createWorkflow.runConfirmation",
          display: WORKFLOW_DISPLAY,
          optionsPolicy: "no-always-allow",
        }),
      ),
    ).options;

    expect(savedOptions.map((option) => option.optionId)).toEqual([
      "allowOnce",
      "deny",
      "workflowRefine",
    ]);
    expect(savedOptions).toEqual(inlineOptions);
    expect(savedOptions.find((option) => option.optionId === "workflowRefine")).toMatchObject({
      kind: "custom",
      label: "Refine",
      response: { decision: "deny" },
    });
  });

  it("display 的字段集合一个都没多（不变式 8：本特性不改任何 display 载荷）", () => {
    const payload = permissionPayload(savedGate());
    // The projection-side counterpart of the skew tripwire: the saved provenance is only allowed to live in
    // detail. Adding fields to the
    // create_workflow display would fail old clients' strict safeParse wholesale (not just drop one field).
    expect(Object.keys(payload.display ?? {}).sort()).toEqual([
      "causalityGraph",
      "diagnostics",
      "errorCount",
      "kind",
      "ok",
    ]);
    expect(payload.display).not.toHaveProperty("saved");
    expect(JSON.stringify(payload.display)).not.toContain(SAVED_RUN_INPUT.saved.path);
  });
});

describe("SaveWorkflow 的确认窗（v4 投影）", () => {
  function saveGate(input: unknown = SAVE_INPUT): ProductProjection {
    return project(
      gateEvents({
        toolName: SAVE_WORKFLOW_TOOL_NAME,
        input,
        reason: "saveWorkflow.confirmation",
        ...(saveWorkflowOptionsPolicy === undefined
          ? {}
          : { optionsPolicy: saveWorkflowOptionsPolicy }),
      }),
    );
  }

  it("落点、覆盖判定、scope 与完整脚本都在 detail 里", () => {
    const payload = permissionPayload(saveGate());

    expect(payload.toolName).toBe(SAVE_WORKFLOW_TOOL_NAME);
    expect(payload.detail).toEqual(SAVE_INPUT);
    const detail = payload.detail as typeof SAVE_INPUT;
    // Overwrite-or-not is decision-critical information: approving one overwrite = agreeing to discard the
    // copy on disk. It must be on the window,
    // and the only channel that holds for every client version is the input.
    expect(detail.overwrite).toBe(true);
    expect(detail.path).toBe("/repo/.zcode/workflows/release-check.dwf.ts");
    expect(detail.scope).toBe("project");
    expect(detail.script).toBe(SCRIPT);
    expect(conversationSnapshotSchema.safeParse(saveGate().getSnapshot()).success).toBe(true);
  });

  it("新建态与覆盖态只差 detail 上的一个布尔（协议不为此分流）", () => {
    const created = permissionPayload(saveGate({ ...SAVE_INPUT, overwrite: false }));
    expect((created.detail as typeof SAVE_INPUT).overwrite).toBe(false);
    // The rest of the payload (including the options and the absence of display) is exactly the same as the
    // overwrite case: new-vs-old is a rendering-layer concern.
    expect({ ...created, detail: undefined }).toEqual({
      ...permissionPayload(saveGate()),
      detail: undefined,
    });
  });

  it("不带 display：v1 刻意不加 save_workflow kind", () => {
    // An unknown display kind degrades cleanly on both sides, so adding one later is purely additive (the
    // spec's Follow-up).
    // Its absence today is precisely where the "content complete" property comes from: everything is in the
    // input.
    const payload = permissionPayload(saveGate());
    expect("display" in payload).toBe(false);
  });

  it("选项 = 允许一次 + 拒绝：没有 always allow，也没有 Refine", () => {
    // optionsPolicy is derived from the real core declaration (see the comment above the file): this also pins
    // the structural closure
    // askOptions.allowAlways=false (invariant 3).
    expect(saveWorkflowOptionsPolicy).toBe("no-always-allow");

    const options = permissionPayload(saveGate()).options;
    expect(options.map((option) => option.optionId)).toEqual(["allowOnce", "deny"]);
    expect(options.some((option) => option.kind === "allowAlways")).toBe(false);
    // Refine means "edit the script and run again"; the save window has no matching action; the synthesis only
    // respects CreateWorkflow.
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });
});
