// Display payloads are not gated at the envelope layer (docs/v4-refactor/10-protocol-spec.md §4.4.5,
// docs/v4-refactor/04-sync-and-recovery.md closed rule 11).
//
// Regression source (2026-09-21, sess_4142de31): the CLI added the `resumedFrom` / `supersededBy` lineage keys to the run
// rows of `list_workflow_runs` (the contracts-side display reuses the tool **output** row schema, so a long output field is
// a long wire field), and the mirror on this side did not keep up. The old behavior was the whole frame being rejected
// with `proto.frameAssemblyInvalidPayload` → the recovery ladder retried on the same content → the session stuck at
// fault.subscription.recoveryFailed, and every snapshot replayed the same stored payload, never self-healing.
// The 2026-09-17 `providerStop` incident was the first of this kind.
//
// The contract now: **decorative payloads do not decide the life or death of a row / frame / subscription**. An
// unrecognized display is dropped (the card degrades to plain text, which is what the spec always promised), and the
// remaining fields project as usual. This file pins four embed points + one whole-frame path.

import { describe, expect, it } from "vitest";
import {
  conversationTopicFrameSchema,
  permissionRequestPayloadSchema,
  reassembleTopicWireFrames,
  toolCallRowSchema,
  toolOutputSchema,
  workflowLaunchMetaSchema,
  type ConversationTopicFrame,
  type ConversationTopicWireFrame,
} from "../src/zcode-protocol-v4/index.js";

const TOPIC = "conversation/session-display-tolerance";
const SUBSCRIPTION_ID = "sub-display-tolerance";

/** The card that really sat in the store on the incident day: 5 of 20 rows carried lineage keys; two of them are used here. */
const POISONED_LIST_RUNS_DISPLAY = {
  kind: "list_workflow_runs",
  runs: [
    {
      runId: "dwfrun-a6c2c519-2758-48a1-995c-50f411bb6ce4",
      label: "pressure-test pause-resume",
      labelSource: "name",
      status: "completed",
      ownedByThisSession: true,
      createdAt: 1_758_000_000_000,
      updatedAt: 1_758_000_100_000,
      spentTokens: 12_345,
      // ↓ The two keys this side's mirror does not know (they grew on the CLI-side output schema in 980e257bff)
      resumedFrom: "dwfrun-3eadf667-8c25-43da-83b1-0e26e7f4897c",
    },
    {
      runId: "dwfrun-2ffa52d4-decb-46eb-8dec-baac736f0187",
      label: "pressure-test pause-resume",
      labelSource: "name",
      status: "stopped",
      stopReason: "superseded",
      ownedByThisSession: true,
      createdAt: 1_758_000_000_000,
      updatedAt: 1_758_000_050_000,
      spentTokens: 6_789,
      supersededBy: "dwfrun-5b042041-d319-4c35-97a1-61d47003e530",
    },
  ],
  truncated: true,
} as const;

/** A valid payload this side recognizes, proving that "ungated" does not mean "unparsed". */
const VALID_DISPLAY = {
  kind: "task_output",
  retrievalStatus: "success",
  taskStatus: "completed",
  output: "done",
} as const;

function toolRow(display: unknown): Record<string, unknown> {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: "call-1",
    toolName: "ListWorkflowRuns",
    status: "success",
    inputText: "{}",
    display,
  };
}

describe("display 载荷在信封层不设门", () => {
  it("row 上带 lineage 键的 list_workflow_runs 卡被丢弃，row 其余字段照常投影", () => {
    const parsed = toolCallRowSchema.safeParse(toolRow(POISONED_LIST_RUNS_DISPLAY));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The card is gone (the renderer degrades to plain text accordingly), but the row itself is intact — that is the proper weight of a "decorative payload".
    expect(parsed.data.display).toBeUndefined();
    expect(parsed.data.toolCallId).toBe("call-1");
    expect(parsed.data.status).toBe("success");
  });

  it("output.display 上的同一份载荷同样只丢卡，text 照常送达", () => {
    const parsed = toolOutputSchema.safeParse({
      text: "<runs>…</runs>",
      display: POISONED_LIST_RUNS_DISPLAY,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.display).toBeUndefined();
    expect(parsed.data.text).toBe("<runs>…</runs>");
  });

  it("认得的 display 仍逐字段通过（不设门不等于不解析）", () => {
    const row = toolCallRowSchema.safeParse(toolRow(VALID_DISPLAY));
    expect(row.success).toBe(true);
    if (row.success) expect(row.data.display).toEqual(VALID_DISPLAY);

    const output = toolOutputSchema.safeParse({ text: "done", display: VALID_DISPLAY });
    expect(output.success).toBe(true);
    if (output.success) expect(output.data.display).toEqual(VALID_DISPLAY);
  });

  // A new display kind used to be a harder wall than a new field: a discriminated union fails outright on an unknown
  // discriminator, so "adding a card kind" amounted to a breaking change for version-locked old clients (presentation.md dropped this approach for that reason).
  it("未来 CLI 新增的 display kind 只是这张卡没有载荷，不是解析失败", () => {
    const parsed = toolCallRowSchema.safeParse(
      toolRow({ kind: "some_future_card_kind_from_a_newer_cli", whatever: 1 }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it.each([
    ["非对象", 42],
    ["缺 kind", { runs: [] }],
    ["kind 非字符串", { kind: 7 }],
    ["认得的 kind 但成员形状不对", { kind: "task_output", retrievalStatus: "nope" }],
  ])("畸形 display（%s）被丢弃而不是拒 row", (_label, display) => {
    const parsed = toolCallRowSchema.safeParse(toolRow(display));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it("缺席的 display 不会被 catch 变成在场的 undefined 键", () => {
    const row = toolRow(undefined);
    delete row.display;
    const parsed = toolCallRowSchema.safeParse(row);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("display" in parsed.data).toBe(false);
  });

  it("确认预览（pendingInteraction.display）失败时退化成纯文本 ask，不拒整份 snapshot", () => {
    const parsed = permissionRequestPayloadSchema.safeParse({
      kind: "permission",
      toolCallId: "call-1",
      toolName: "ListWorkflowRuns",
      summary: "列出本项目的 workflow run",
      detail: {},
      options: [],
      display: POISONED_LIST_RUNS_DISPLAY,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  it("启动行的 workflowLaunch.display 失败时只是这一行没有图", () => {
    const parsed = workflowLaunchMetaSchema.safeParse({
      runId: "dwfrun-a6c2c519",
      toolCallId: "launch-2f0c9d18",
      display: { kind: "create_workflow", causalityGraph: { unexpected: true } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.display).toBeUndefined();
  });

  // This one is the incident itself: the whole frame goes through real physical reassembly. Before the fix this would
  // get { kind: "rejected", reasonCode: "proto.frameAssemblyInvalidPayload" },
  // and upon receiving that fault the store would retry on the same content and eventually fail closed.
  it("承载被污染卡片的整帧仍然完整重组，不产生 InvalidPayload fault", () => {
    const frame: ConversationTopicFrame = {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 10,
      toSeq: 11,
      sentAt: 1_700_000_000_000,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: toolRow(POISONED_LIST_RUNS_DISPLAY) as never }],
      },
    };
    const wire: ConversationTopicWireFrame = {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-display-tolerance",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      frame,
    };

    const result = reassembleTopicWireFrames([wire], conversationTopicFrameSchema);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const delta = result.frame.payload.kind === "deltas" ? result.frame.payload.deltas[0] : null;
    expect(delta?.op).toBe("row.upserted");
    const row = delta?.op === "row.upserted" ? delta.row : null;
    expect(row?.kind).toBe("toolCall");
    // The frame survived; the only cost is that this card has no structured payload.
    expect(row?.kind === "toolCall" ? row.display : "unreachable").toBeUndefined();
  });

  it("信封本身没有被放松：必填字段缺失仍然拒整帧", () => {
    const { toolCallId: _dropped, ...rowMissingRequired } = toolRow(VALID_DISPLAY);
    const frame = {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 10,
      toSeq: 11,
      sentAt: 1_700_000_000_000,
      payload: {
        kind: "deltas",
        deltas: [{ op: "row.upserted", row: rowMissingRequired }],
      },
    };
    const wire = {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: "logical-display-tolerance-2",
      logicalFrameOrdinal: 1,
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      frame,
    } as unknown as ConversationTopicWireFrame;

    expect(reassembleTopicWireFrames([wire], conversationTopicFrameSchema)).toEqual({
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidPayload",
    });
  });
});
