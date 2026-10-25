// Classification of physical assembly faults (docs/v4-refactor/04-sync-and-recovery.md closed rule 11).
//
// The recovery ladder treats faults as transient by default: resync → resume → forced snapshot → fail closed. A schema
// rejection is not transient — the bytes already passed the four gates of length/checksum/UTF-8/JSON, so being rejected
// means this side cannot read the **content** the peer sent, and the resume rung would only redeliver the same deltas.
// 2026-09-21 (sess_4142de31) was exactly this: a tool card payload carried two extra keys, the ladder burned three
// frames on the same content before failing closed, and the user manually reconnected twice, burning three frames each time.
//
// This file pins two things: the boundaries of the classification function, and the fact that **the producer and the
// classifier use the same word** — the symptom of those two diverging is precisely the class of silent mismatch this
// mechanism exists to fix, so after constantizing them a test must actually run the assembler end to end.

import { describe, expect, it } from "vitest";
import {
  conversationTopicFrameSchema,
  isDeterministicContentFault,
  reassembleTopicWireFrames,
  SUBSCRIPTION_CONTENT_REJECTED,
  TopicWireFrameAssembler,
  WIRE_FAULT_INVALID_PAYLOAD,
  type ConversationTopicWireFrame,
} from "../src/zcode-protocol-v4/index.js";

const TOPIC = "conversation/session-wire-fault";
const SUBSCRIPTION_ID = "sub-wire-fault";

/** A frame the schema cannot accept: payload.kind matches no known branch. */
function schemaInvalidWire(): ConversationTopicWireFrame {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: "logical-wire-fault",
    logicalFrameOrdinal: 1,
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    frame: {
      topic: TOPIC,
      subscriptionId: SUBSCRIPTION_ID,
      fromSeq: 1,
      toSeq: 2,
      sentAt: 1,
      payload: { kind: "not-a-real-payload-kind" },
    },
  } as unknown as ConversationTopicWireFrame;
}

describe("确定性内容 fault 的分类", () => {
  // 刻意不把这些算进来：它们可能来自传输或组装路径本身，重投确实可能不同。把瞬态误判成确定性
  // 会让本该自愈的 gap 停在原地，那比多一次无用重试更坏。
  it.each([
    "proto.frameAssemblyInvalidJson",
    "proto.frameAssemblyChecksumMismatch",
    "proto.frameAssemblyLengthMismatch",
    "proto.frameAssemblyTooLarge",
    "proto.frameAssemblyTimedOut",
    "proto.frameAssemblyMetadataMismatch",
    "proto.frameAssemblySuperseded",
  ])("%s 仍按瞬态处理", (reasonCode) => {
    expect(isDeterministicContentFault(reasonCode)).toBe(false);
  });

  it("缺失的 reasonCode 不算确定性失败（未知就按瞬态，保留自愈路径）", () => {
    expect(isDeterministicContentFault(undefined)).toBe(false);
  });

  it("两个终态 code 是不同的词：内容失败不该被聚合成一次链路抖动", () => {
    expect(SUBSCRIPTION_CONTENT_REJECTED).not.toBe("fault.subscription.recoveryFailed");
    // Telemetry extracts codes via /^fault\.[A-Za-z0-9._-]+$/ (useSessionSubscriptionErrorTelemetry);
    // a new code must fit that shape to be aggregated separately instead of degrading to fault.subscribe.unknown.
    expect(SUBSCRIPTION_CONTENT_REJECTED).toMatch(/^fault\.[A-Za-z0-9._-]+$/);
  });
});

describe("产出侧与判定侧用同一个 reason code", () => {
  it("incremental assembler 的 schema 拒收产出可被判定为内容失败", () => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const events = assembler.accept(schemaInvalidWire());
    const fault = events.find((event) => event.kind === "fault");
    expect(fault).toBeDefined();
    if (fault?.kind !== "fault") return;
    expect(fault.fault.reasonCode).toBe(WIRE_FAULT_INVALID_PAYLOAD);
    expect(isDeterministicContentFault(fault.fault.reasonCode)).toBe(true);
  });

  it("一次性 reassemble 的 schema 拒收同样可被判定", () => {
    const result = reassembleTopicWireFrames([schemaInvalidWire()], conversationTopicFrameSchema);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.reasonCode).toBe(WIRE_FAULT_INVALID_PAYLOAD);
    expect(isDeterministicContentFault(result.reasonCode)).toBe(true);
  });
});
