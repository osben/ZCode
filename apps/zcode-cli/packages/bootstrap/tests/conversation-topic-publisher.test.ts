// ConversationTopicPublisher golden tests (M2 transport shell; 10 §3 / 04 recovery / 05 flush pipeline).
// Core assertion surface:
//   1. subscribe(base) decision matrix: epoch mismatch / seq outside the retention window / seq ahead → snapshot; inside the window → resume
//   2. Frame interval accounting (fromSeq, toSeq] joins seamlessly (including "a frame fully filtered by a profile" still covering the interval)
//   3. snapshot frame + subsequent streaming frames' applied final state ≡ full direct delivery (recovery protocol golden path)
//   4. Resubscription replacement semantics (R-01): old subId invalidated, old buffer cleared
//   5. Resync overflow downgrade: realigning to a snapshot without breaking the following stream
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
import type {
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  applyConversationDeltas,
  conversationTopicFrameSchema,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import {
  appendConversationSubscriberBuffer,
  ConversationTopicPublisher,
  conversationSubscriberBufferByteLimit,
  PROJECTION_TERMINAL_RESERVE_BYTES,
  ProductProjection,
} from "../src/zcode-protocol-v4/index.js";

// ── Event construction ──

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  constructor(private readonly sessionId = "session-1") {}

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
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

function turnEvents(log: EventLog, turnNumber: number): SessionEvent[] {
  const turnId = `turn-${turnNumber}`;
  const start = log.events.length;
  log.push(SessionEventType.TurnStarted, { turnNumber, input: `任务 ${turnNumber}` }, { turnId });
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_start", delta: "", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: `回答 ${turnNumber} 上半`, done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: ` 下半`, done: false },
    { turnId },
  );
  log.push(
    SessionEventType.TurnComplete,
    {
      response: `回答 ${turnNumber}`,
      tokenCount: 10,
      toolCallCount: 0,
      duration: 100,
      resultType: "success",
    },
    { turnId },
  );
  return log.events.slice(start);
}

function makeLog(turns: number): EventLog {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow: 200_000,
  });
  for (let i = 1; i <= turns; i++) turnEvents(log, i);
  return log;
}

/** Authoritative final state: run the reducer over the full replay directly. */
function authoritativeSnapshot(events: readonly SessionEvent[]): ConversationSnapshot {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection.getSnapshot();
}

/** Client apply rules (10 §3.2): a snapshot replaces wholesale; a deltas frame requires fromSeq === store.seq. */
function clientApply(
  store: { seq: number; snapshot: ConversationSnapshot | null },
  frame: ConversationTopicFrame,
): void {
  expect(() => conversationTopicFrameSchema.parse(frame)).not.toThrow();
  if (frame.payload.kind === "snapshot") {
    store.snapshot = frame.payload.snapshot;
    store.seq = frame.toSeq;
    return;
  }
  if (frame.toSeq <= store.seq) return; // late/duplicate frame
  expect(frame.fromSeq).toBe(store.seq); // a gap fails the test (this suite should never have gaps)
  expect(store.snapshot).not.toBeNull();
  // seq semantics = "the containing frame's toSeq" (10 §4.2 R-03); it does not propagate through deltas — the client aligns itself after apply.
  store.snapshot = {
    ...applyConversationDeltas(store.snapshot as ConversationSnapshot, frame.payload.deltas),
    seq: frame.toSeq,
  };
  store.seq = frame.toSeq;
}

describe("分享导入来源种子", () => {
  it("在 publisher 快照中保留来源提示且不产生 conversation delta", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
    const before = publisher.getSnapshot();

    publisher.seedSharedContextImport({ title: "导入的分享" });

    const snapshot = publisher.getSnapshot();
    expect(snapshot.sharedContextImport).toEqual({ title: "导入的分享" });
    expect(snapshot.revision).toBe(before.revision);
    expect(snapshot.seq).toBe(before.seq);
    expect(snapshot.rows.window).toEqual([]);
  });
});

describe("worktree preparation subscriber refresh", () => {
  it("keeps an outstanding reservation and follows it with the newer metadata snapshot", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
    const subscribed = publisher.subscribeReserved({ connectionId: "conn-1" });
    const initialReservation = subscribed.reservation;
    expect(initialReservation).not.toBeNull();

    publisher.seedWorktreePreparation({
      status: "preparing",
      branchName: "zcode/fresh-otter",
      targetPath: "/tmp/fresh-otter",
    });
    publisher.requestSnapshotForSubscribers();

    expect(publisher.reserveFlush(subscribed.ack.subscriptionId)).toBe(initialReservation);
    expect(initialReservation?.commit()).toBe(true);
    const updated = publisher.reserveFlush(subscribed.ack.subscriptionId);
    expect(updated?.frame.payload.kind).toBe("snapshot");
    if (updated?.frame.payload.kind === "snapshot") {
      expect(updated.frame.payload.snapshot.meta.worktreePreparation).toMatchObject({
        status: "preparing",
        branchName: "zcode/fresh-otter",
        targetPath: "/tmp/fresh-otter",
      });
    }
  });

  it("sends a refreshed snapshot after host-owned preparation changes", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
    const { ack } = publisher.subscribe({ connectionId: "conn-1" });
    publisher.seedWorktreePreparation({
      status: "preparing",
      branchName: "zcode/fresh-otter",
      targetPath: "/tmp/fresh-otter",
    });
    publisher.requestSnapshotForSubscribers();

    const frame = publisher.flush(ack.subscriptionId);
    expect(frame?.payload.kind).toBe("snapshot");
    if (frame?.payload.kind === "snapshot") {
      expect(frame.payload.snapshot.meta.worktreePreparation).toMatchObject({
        status: "preparing",
        branchName: "zcode/fresh-otter",
        targetPath: "/tmp/fresh-otter",
      });
    }
  });

  it("sends a fresh snapshot when a reconnecting subscriber resumes from an older transcript sequence", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
    const first = publisher.subscribe({ connectionId: "conn-1" });
    expect(first.frame?.payload.kind).toBe("snapshot");
    const base = { logEpoch: first.ack.logEpoch, seq: first.ack.seq };

    publisher.seedWorktreePreparation({
      status: "preparing",
      branchName: "zcode/fresh-otter",
      targetPath: "/tmp/fresh-otter",
    });

    const resumed = publisher.subscribe({ connectionId: "conn-2", base });
    expect(resumed.ack.mode).toBe("snapshot");
    expect(resumed.frame?.payload.kind).toBe("snapshot");
    if (resumed.frame?.payload.kind === "snapshot") {
      expect(resumed.frame.payload.snapshot.meta.worktreePreparation).toMatchObject({
        status: "preparing",
        branchName: "zcode/fresh-otter",
        targetPath: "/tmp/fresh-otter",
      });
    }
  });

  it("sends a fresh snapshot when preparation metadata was cleared after the client disconnected", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
    const first = publisher.subscribe({ connectionId: "conn-1" });
    const base = { logEpoch: first.ack.logEpoch, seq: first.ack.seq };

    publisher.seedWorktreePreparation({
      status: "preparing",
      branchName: "zcode/fresh-otter",
      targetPath: "/tmp/fresh-otter",
    });
    publisher.seedWorktreePreparation(null);

    const resumed = publisher.subscribe({ connectionId: "conn-2", base });
    expect(resumed.ack.mode).toBe("snapshot");
    expect(resumed.frame?.payload.kind).toBe("snapshot");
    if (resumed.frame?.payload.kind === "snapshot") {
      expect(resumed.frame.payload.snapshot.meta.worktreePreparation).toBeUndefined();
    }
  });
});

describe("subscribe(base) 裁决矩阵", () => {
  function publisherWith(events: readonly SessionEvent[], retention?: number) {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 1_700_000_999_000,
      retention,
    });
    for (const event of events) publisher.ingest(event);
    return publisher;
  }

  it("无 base → snapshot（fromSeq=0，snapshot.seq=toSeq）", () => {
    const publisher = publisherWith(makeLog(1).events);
    const { ack, frame } = publisher.subscribe({ connectionId: "conn-1" });
    expect(ack.mode).toBe("snapshot");
    expect(ack.logEpoch).toBe("epoch-1");
    expect(frame).not.toBeNull();
    expect(frame!.fromSeq).toBe(0);
    expect(frame!.payload.kind).toBe("snapshot");
    if (frame!.payload.kind === "snapshot") {
      expect(frame!.payload.snapshot.seq).toBe(frame!.toSeq);
    }
  });

  it("epoch 不匹配 → snapshot（CLI 重启后 base 必然失效）", () => {
    const publisher = publisherWith(makeLog(1).events);
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-0", seq: 3 },
    });
    expect(ack.mode).toBe("snapshot");
  });

  it("base.seq 超前当前水位 → snapshot（水位不变量防御）", () => {
    const publisher = publisherWith(makeLog(1).events);
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: 999 },
    });
    expect(ack.mode).toBe("snapshot");
  });

  it("base.seq 掉出保留窗 → snapshot；窗内 → resume", () => {
    // 3 turns (1 + 3×5 = 16 events) with the retention window squeezed to 5: floor = seq 11.
    const publisher = publisherWith(makeLog(3).events, 5);
    expect(
      publisher.subscribe({
        connectionId: "conn-out",
        base: { logEpoch: "epoch-1", seq: 10 },
      }).ack.mode,
    ).toBe("snapshot");
    expect(
      publisher.subscribe({
        connectionId: "conn-in",
        base: { logEpoch: "epoch-1", seq: 11 },
      }).ack.mode,
    ).toBe("resume");
  });

  it("base.seq === 当前水位 → resume 且无初始帧", () => {
    const log = makeLog(1);
    const publisher = publisherWith(log.events);
    const { ack, frame } = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: log.events.length },
    });
    expect(ack.mode).toBe("resume");
    expect(frame).toBeNull();
  });
});

describe("恢复协议黄金路径：snapshot/resume + 续流 ≡ 全量重放", () => {
  it("中途订阅（snapshot）+ 续流帧终态一致", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };

    // Subscribe only after the first turn completes.
    const firstHalf = log.events.slice(0, 6);
    const secondHalf = log.events.slice(6);
    for (const event of firstHalf) publisher.ingest(event);
    const { frame } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });
    clientApply(store, frame!);
    const subId = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
      deliveryProfile: "continuous",
    }); // resubscribe goes through resume (watermark aligned → no initial frame), yielding the active subId
    expect(subId.ack.mode).toBe("resume");

    // Streaming continuation: flush after every event (finest-grained frames).
    for (const event of secondHalf) {
      publisher.ingest(event);
      const next = publisher.flush(subId.ack.subscriptionId);
      if (next) clientApply(store, next);
    }
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });

  it("断线重连（resume）：base 窗内续传帧 + 后续流帧终态一致", () => {
    const log = makeLog(3);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };

    // First follow online up to the 8th event.
    const online = log.events.slice(0, 8);
    const offline = log.events.slice(8, 12);
    const afterReconnect = log.events.slice(12);

    for (const event of online.slice(0, 1)) publisher.ingest(event);
    const first = publisher.subscribe({ connectionId: "conn-1" });
    clientApply(store, first.frame!);
    for (const event of online.slice(1)) {
      publisher.ingest(event);
      const frame = publisher.flush(first.ack.subscriptionId);
      if (frame) clientApply(store, frame);
    }

    // Events keep arriving while offline (the subscription is still attached but the client cannot receive → invalidate the old subscription to simulate the disconnect).
    publisher.unsubscribe(first.ack.subscriptionId);
    for (const event of offline) publisher.ingest(event);

    // Reconnect with base: should resume and fill the gap in one frame.
    const second = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(second.ack.mode).toBe("resume");
    clientApply(store, second.frame!);
    expect(store.seq).toBe(12);

    for (const event of afterReconnect) {
      publisher.ingest(event);
      const frame = publisher.flush(second.ack.subscriptionId);
      if (frame) clientApply(store, frame);
    }
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });

  it("replayable 订阅者：resume 重放过 profile 过滤，终态仍与全量重放一致", () => {
    // replayable subscriber: tool input streaming happened inside the offline window; the inputText row.delta is
    // filtered by replayable, and closure relies on ToolCallScheduled's row.upserted (profiles.ts closure invariant).
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const turnId = "turn-1";
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId });
    const preDropCount = log.events.length;
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "bash" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"command":"ls"}', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "ls" },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 10, resultType: "success" },
      { turnId },
    );

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };
    for (const event of log.events.slice(0, preDropCount)) publisher.ingest(event);
    const first = publisher.subscribe({ connectionId: "conn-1" });
    clientApply(store, first.frame!);
    publisher.unsubscribe(first.ack.subscriptionId);

    for (const event of log.events.slice(preDropCount)) publisher.ingest(event);
    const second = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(second.ack.mode).toBe("resume");
    clientApply(store, second.frame!);
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });
});

describe("帧区间记账与替换语义", () => {
  it("批量 cold rehydrate 与逐事件 reducer 终态一致，中间 base 经 snapshot boundary 恢复", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    for (let turnNumber = 1; turnNumber <= 40; turnNumber += 1) {
      const turnId = `turn-${turnNumber}`;
      log.push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          input: `任务 ${turnNumber}`,
          messageId: `message-user-${turnNumber}`,
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: `message-assistant-${turnNumber}`,
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: `回答 ${turnNumber}`, done: false },
        { turnId },
      );
      const toolCallId = `tool-${turnNumber}`;
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_start",
          delta: "",
          done: false,
          toolCallId,
          toolName: "bash",
        },
        { turnId },
      );
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "tool_input_delta",
          delta: `{"command":"printf ${turnNumber}"}`,
          done: false,
          toolCallId,
        },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId,
          toolName: "bash",
          input: { command: `printf ${turnNumber}` },
          schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
        },
        { turnId },
      );
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId,
          result: { success: true, content: `tool output ${turnNumber}` },
          duration: 10,
        },
        { turnId },
      );
      log.push(
        SessionEventType.TurnComplete,
        {
          response: `回答 ${turnNumber}`,
          tokenCount: 10,
          toolCallCount: 1,
          duration: 100,
          resultType: "success",
        },
        { turnId },
      );
    }

    const strict = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of log.events) strict.ingest(event);
    const cold = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    cold.rehydrate(log.events);
    expect(cold.getSnapshot()).toEqual(strict.getSnapshot());

    const baseEventCount = 73;
    const base = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of log.events.slice(0, baseEventCount)) base.ingest(event);
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };
    clientApply(store, base.subscribe({ connectionId: "base" }).frame!);

    const resumed = cold.subscribe({
      connectionId: "mobile-replay",
      deliveryProfile: "replayable",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(resumed.ack.mode).toBe("snapshot");
    clientApply(store, resumed.frame!);
    const expectedFrame = cold.subscribe({ connectionId: "fresh-snapshot" }).frame!;
    expect(expectedFrame.payload.kind).toBe("snapshot");
    expect(store.snapshot).toEqual(
      expectedFrame.payload.kind === "snapshot" ? expectedFrame.payload.snapshot : null,
    );
  });

  it("rehydrate replay 非 size 异常时保留旧 projection/log/subscription reservation", () => {
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const live = new EventLog();
    publisher.ingest(
      live.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );
    const subscribed = publisher.subscribe({ connectionId: "desktop" });
    publisher.ingest(
      live.push(SessionEventType.SessionTitleUpdated, {
        previousTitle: "old",
        title: "live title",
        source: "custom",
      }),
    );
    const reservation = publisher.reserveFlush(subscribed.ack.subscriptionId);
    const before = publisher.getSnapshot();
    const persisted = new EventLog();
    persisted.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    persisted.push(SessionEventType.TurnError, { turnPhase: "model" });

    expect(() => publisher.rehydrate(persisted.events)).toThrow(TypeError);

    expect(publisher.getSnapshot()).toEqual(before);
    expect(publisher.hasSubscription(subscribed.ack.subscriptionId, "desktop")).toBe(true);
    expect(publisher.reserveFlush(subscribed.ack.subscriptionId)).toBe(reservation);
    expect(reservation?.commit()).toBe(true);
  });

  it("continuous 订阅者：tool_input_delta 透传 inputText 供桌面实时预览", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const turnId = "turn-1";
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "Write" },
      { turnId },
    );

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });

    const streamDelta = log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"file_path":"src/app.ts","content":"line 1\\n',
        done: false,
        toolCallId: "tc-1",
      },
      { turnId },
    );
    publisher.ingest(streamDelta);
    const frame = publisher.flush(ack.subscriptionId);

    expect(frame?.payload.kind).toBe("deltas");
    const deltas = frame?.payload.kind === "deltas" ? frame.payload.deltas : [];
    expect(deltas).toContainEqual({
      op: "row.delta",
      rowId: expect.any(Number),
      path: "inputText",
      append: '{"file_path":"src/app.ts","content":"line 1\\n',
    });
  });

  it("flush 帧 (fromSeq, toSeq] 无缝衔接；无新内容返回 null", () => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    publisher.ingest(log.events[0]!);
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });

    let watermark = 1;
    for (const event of log.events.slice(1)) {
      publisher.ingest(event);
      const frame = publisher.flush(ack.subscriptionId);
      expect(frame).not.toBeNull();
      expect(frame!.fromSeq).toBe(watermark);
      expect(frame!.toSeq).toBe(event.sequenceNumber);
      watermark = frame!.toSeq;
    }
    expect(publisher.flush(ack.subscriptionId)).toBeNull();
  });

  it("整帧被 profile 过滤时区间照样推进（连续性判定不受过滤影响）", () => {
    // Under replayable, tool_input_delta only produces row.delta(inputText) → filtered to empty,
    // but the frame interval must still cover that seq, or the client would misjudge a gap.
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const turnId = "turn-1";
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "bash" },
      { turnId },
    );

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const { ack } = publisher.subscribe({ connectionId: "conn-1" }); // replayable

    // Pure inputText stream event: every delta is filtered.
    const pureStream = log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_delta", delta: '{"a":1}', done: false, toolCallId: "tc-1" },
      { turnId },
    );
    publisher.ingest(pureStream);
    const frame = publisher.flush(ack.subscriptionId);
    expect(frame).not.toBeNull();
    expect(frame!.payload).toEqual({ kind: "deltas", deltas: [] });
    expect(frame!.toSeq).toBe(pureStream.sequenceNumber);

    // The subsequent structural event continues from the new watermark.
    const scheduled = log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { a: 1 },
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    publisher.ingest(scheduled);
    const next = publisher.flush(ack.subscriptionId);
    expect(next!.fromSeq).toBe(pureStream.sequenceNumber);
    expect(next!.toSeq).toBe(scheduled.sequenceNumber);
  });

  it("replayable 订阅者：scheduled 定稿必须在 upsert 中携带完整 inputText", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const turnId = "turn-1";
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "Write" },
      { turnId },
    );

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const { ack } = publisher.subscribe({ connectionId: "conn-1" }); // replayable
    const input = { file_path: "src/app.ts", content: "line 1\nline 2" };
    const scheduled = log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-1",
        toolName: "Write",
        input,
        schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
      },
      { turnId },
    );
    publisher.ingest(scheduled);
    const frame = publisher.flush(ack.subscriptionId);

    expect(frame?.payload.kind).toBe("deltas");
    const deltas = frame?.payload.kind === "deltas" ? frame.payload.deltas : [];
    const upsert = deltas.find(
      (delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall",
    );
    expect(upsert).toBeDefined();
    if (upsert?.op === "row.upserted" && upsert.row.kind === "toolCall") {
      expect(upsert.row.input).toEqual(input);
      expect(upsert.row.inputText).toBe(JSON.stringify(input));
    }
  });

  it("continuous 订阅者：model.streaming tool_call 用完整输入收口已有工具行", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 });
    const turnId = "turn-1";
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "tool_input_start", delta: "", done: false, toolCallId: "tc-1", toolName: "Write" },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"file_path":"src/app.ts"',
        done: false,
        toolCallId: "tc-1",
      },
      { turnId },
    );

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });

    const input = { file_path: "src/app.ts", content: "done" };
    const finalToolCall = log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_call",
        delta: "",
        done: true,
        toolCallId: "tc-1",
        toolName: "Write",
        input,
      },
      { turnId },
    );
    publisher.ingest(finalToolCall);
    const frame = publisher.flush(ack.subscriptionId);

    expect(frame?.payload.kind).toBe("deltas");
    const deltas = frame?.payload.kind === "deltas" ? frame.payload.deltas : [];
    const upsert = deltas.find(
      (delta) => delta.op === "row.upserted" && delta.row.kind === "toolCall",
    );
    expect(upsert).toBeDefined();
    if (upsert?.op === "row.upserted" && upsert.row.kind === "toolCall") {
      expect(upsert.row.input).toEqual(input);
      expect(upsert.row.inputText).toBe(JSON.stringify(input));
    }
  });

  it("重订阅替换（R-01）：旧 subId 作废，不再产帧", () => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    publisher.ingest(log.events[0]!);
    const first = publisher.subscribe({ connectionId: "conn-1" });
    const second = publisher.subscribe({ connectionId: "conn-1" });
    expect(second.ack.subscriptionId).not.toBe(first.ack.subscriptionId);
    expect(publisher.hasSubscription(first.ack.subscriptionId)).toBe(false);

    publisher.ingest(log.events[1]!);
    expect(publisher.flush(first.ack.subscriptionId)).toBeNull();
    expect(publisher.flush(second.ack.subscriptionId)).not.toBeNull();
  });

  it("resync 溢出降级：snapshot 重对齐后续流不断", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };
    publisher.ingest(log.events[0]!);
    const { ack, frame } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });
    clientApply(store, frame!);

    // Events advance without flush (simulating buffer buildup), then resync is triggered.
    for (const event of log.events.slice(1, 8)) publisher.ingest(event);
    const resyncFrame = publisher.resync(ack.subscriptionId);
    clientApply(store, resyncFrame!);
    expect(store.seq).toBe(8);
    // After resync the buffer is empty: flush returns null when there are no new events.
    expect(publisher.flush(ack.subscriptionId)).toBeNull();

    for (const event of log.events.slice(8)) {
      publisher.ingest(event);
      const next = publisher.flush(ack.subscriptionId);
      if (next) clientApply(store, next);
    }
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });

  it("same-sub resync 从客户端 base 重建 resume，并作废旧 reservation", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of log.events.slice(0, 4)) publisher.ingest(event);
    const initial = publisher.subscribe({
      connectionId: "mobile",
      deliveryProfile: "replayable",
    });
    for (const event of log.events.slice(4, 8)) publisher.ingest(event);
    const oldReservation = publisher.reserveFlush(initial.ack.subscriptionId);
    expect(oldReservation?.frame.fromSeq).toBe(4);

    const recovered = publisher.resyncReserved(initial.ack.subscriptionId, {
      base: { logEpoch: "epoch-1", seq: 6 },
    });
    expect(recovered?.ack).toEqual({
      subscriptionId: initial.ack.subscriptionId,
      mode: "resume",
      logEpoch: "epoch-1",
    });
    expect(recovered?.reservation?.frame).toMatchObject({
      subscriptionId: initial.ack.subscriptionId,
      fromSeq: 6,
      toSeq: 8,
      payload: { kind: "deltas" },
    });
    expect(oldReservation?.commit()).toBe(false);

    publisher.ingest(log.events[8]!);
    expect(recovered?.reservation?.commit()).toBe(true);
    expect(publisher.flush(initial.ack.subscriptionId)).toMatchObject({
      fromSeq: 8,
      toSeq: 9,
    });
  });

  it("same-sub recovery admission 失败可 rollback 原 reservation 与未发 buffer", () => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    publisher.ingest(log.events[0]!);
    const initial = publisher.subscribe({ connectionId: "mobile" });
    publisher.ingest(log.events[1]!);
    const oldReservation = publisher.reserveFlush(initial.ack.subscriptionId)!;

    const recovered = publisher.resyncReserved(initial.ack.subscriptionId, {
      base: null,
      forceSnapshot: true,
    })!;
    expect(oldReservation.commit()).toBe(false);
    // New events inside the encode/admission window go into the recovery's buffer; rollback must not overwrite what was lost.
    publisher.ingest(log.events[2]!);
    expect(recovered.rollback()).toBe(true);
    expect(recovered.reservation?.commit()).toBe(false);
    expect(publisher.reserveFlush(initial.ack.subscriptionId)).toBe(oldReservation);
    expect(oldReservation.commit()).toBe(true);
    const afterRollback = publisher.flush(initial.ack.subscriptionId);
    expect(afterRollback).toMatchObject({
      fromSeq: 2,
      toSeq: 3,
    });
    expect(afterRollback?.payload.kind).toBe("deltas");
    if (afterRollback?.payload.kind === "deltas") {
      expect(afterRollback.payload.deltas.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["null base", { base: null }],
    ["old epoch", { base: { logEpoch: "old", seq: 6 } }],
    ["force snapshot", { base: { logEpoch: "epoch-1", seq: 6 }, forceSnapshot: true }],
  ])("same-sub resync %s 回最新 snapshot", (_case, request) => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of log.events) publisher.ingest(event);
    const initial = publisher.subscribe({ connectionId: "mobile" });
    const recovered = publisher.resyncReserved(initial.ack.subscriptionId, request);
    expect(recovered?.ack.mode).toBe("snapshot");
    expect(recovered?.ack.subscriptionId).toBe(initial.ack.subscriptionId);
    expect(recovered?.reservation?.frame).toMatchObject({
      subscriptionId: initial.ack.subscriptionId,
      fromSeq: 0,
      toSeq: log.events.length,
      payload: { kind: "snapshot" },
    });
  });

  it("same-sub aligned resume 仍发送空 recovery logical frame 以收口 flight", () => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of log.events) publisher.ingest(event);
    const initial = publisher.subscribe({ connectionId: "mobile" });
    const recovered = publisher.resyncReserved(initial.ack.subscriptionId, {
      base: { logEpoch: "epoch-1", seq: log.events.length },
    });
    expect(recovered?.ack.mode).toBe("resume");
    expect(recovered?.reservation?.frame).toMatchObject({
      subscriptionId: initial.ack.subscriptionId,
      fromSeq: log.events.length,
      toSeq: log.events.length,
      payload: { kind: "deltas", deltas: [] },
    });
  });

  it("mobile same-sub resync 不作废 desktop sibling reservation", () => {
    const log = makeLog(1);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    publisher.ingest(log.events[0]!);
    const desktop = publisher.subscribe({ connectionId: "desktop", deliveryProfile: "continuous" });
    const mobile = publisher.subscribe({ connectionId: "mobile", deliveryProfile: "replayable" });
    publisher.ingest(log.events[1]!);
    const desktopReservation = publisher.reserveFlush(desktop.ack.subscriptionId);
    const mobileReservation = publisher.reserveFlush(mobile.ack.subscriptionId);

    const recovered = publisher.resyncReserved(mobile.ack.subscriptionId, {
      base: { logEpoch: "epoch-1", seq: 1 },
    });
    expect(mobileReservation?.commit()).toBe(false);
    expect(desktopReservation?.commit()).toBe(true);
    expect(recovered?.reservation?.commit()).toBe(true);
  });

  it("SAT24：desktop continuous 与 mobile replayable 消费同一份完整 subagent 投影", () => {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 200_000,
    });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "并行派生" },
      { turnId: "turn-1" },
    );
    for (let index = 1; index <= 7; index += 1) {
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: `agent-${index}`,
          agentType: "Explore",
          childSessionId: `sess-child-${index}`,
          description: `child ${index}`,
          parentToolCallId: `call-${index}`,
          status: "running",
        },
        { turnId: "turn-1" },
      );
    }
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);

    const desktop = publisher.subscribe({
      connectionId: "desktop",
      deliveryProfile: "continuous",
    });
    const mobile = publisher.subscribe({
      connectionId: "mobile",
      deliveryProfile: "replayable",
    });
    for (const subscription of [desktop, mobile]) {
      expect(subscription.frame?.payload.kind).toBe("snapshot");
      if (subscription.frame?.payload.kind === "snapshot") {
        expect(subscription.frame.payload.snapshot.subagents?.running).toHaveLength(7);
      }
      expect(subscription.reservation?.commit()).toBe(true);
    }

    const eighth = log.push(
      SessionEventType.SubagentSpawned,
      {
        agentId: "agent-8",
        agentType: "Explore",
        childSessionId: "sess-child-8",
        description: "child 8",
        parentToolCallId: "call-8",
        status: "running",
      },
      { turnId: "turn-1" },
    );
    publisher.ingest(eighth);
    for (const subscription of [desktop, mobile]) {
      const frame = publisher.reserveFlush(subscription.ack.subscriptionId)?.frame;
      expect(frame?.payload.kind).toBe("deltas");
      if (frame?.payload.kind === "deltas") {
        const patch = frame.payload.deltas.find(
          (delta) => delta.op === "state.updated" && delta.patch.subagents,
        );
        expect(patch).toMatchObject({
          op: "state.updated",
          patch: { subagents: { endedTotal: 0 } },
        });
        if (patch?.op === "state.updated") {
          expect(patch.patch.subagents?.running).toHaveLength(8);
        }
      }
    }
  });
});

describe("subscriber 有界缓冲与自动 resync", () => {
  function uniqueDeltas(count: number): ConversationDelta[] {
    return Array.from({ length: count }, (_, index) => ({
      op: "row.delta" as const,
      rowId: index + 1,
      path: "text" as const,
      append: "x",
    }));
  }

  function singleDeltaPayloadAtBytes(targetBytes: number): ConversationDelta {
    const empty: ConversationDelta = {
      op: "row.delta",
      rowId: 1,
      path: "text",
      append: "",
    };
    const overhead = utf8JsonByteLength({
      kind: "deltas",
      deltas: [empty],
    });
    expect(overhead).toBeLessThan(targetBytes);
    const delta: ConversationDelta = {
      ...empty,
      append: "x".repeat(targetBytes - overhead),
    };
    expect(utf8JsonByteLength({ kind: "deltas", deltas: [delta] })).toBe(targetBytes);
    return delta;
  }

  it("coalesce 后 500 ops 可缓冲，501 ops 触发 overflow", () => {
    expect(appendConversationSubscriberBuffer([], uniqueDeltas(500))).toMatchObject({
      kind: "buffered",
      deltas: { length: 500 },
    });
    expect(appendConversationSubscriberBuffer([], uniqueDeltas(501))).toEqual({ kind: "overflow" });
    expect(appendConversationSubscriberBuffer([], uniqueDeltas(501), { maxOps: 501 })).toEqual({
      kind: "overflow",
    });
    expect(() => appendConversationSubscriberBuffer([], uniqueDeltas(1), { maxOps: NaN })).toThrow(
      /non-negative finite/u,
    );
  });

  it("encoded logical payload 正好 1MiB 可缓冲，超一字节 overflow", () => {
    const max = PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes;
    expect(appendConversationSubscriberBuffer([], [singleDeltaPayloadAtBytes(max)])).toMatchObject({
      kind: "buffered",
      encodedBytes: max,
    });
    expect(appendConversationSubscriberBuffer([], [singleDeltaPayloadAtBytes(max + 1)])).toEqual({
      kind: "overflow",
    });
    expect(
      appendConversationSubscriberBuffer([], [singleDeltaPayloadAtBytes(max + 1)], {
        maxBytes: max + 1,
      }),
    ).toEqual({ kind: "overflow" });
  });

  /**
   * Backlog beyond the tail window: the upserts of 40 turns (~120 rows) all sit in the buffer while the wire snapshot
   * carries only the last 60 rows — the buffer genuinely exceeds the snapshot upper bound, so downgrading to a
   * snapshot pays off (05 §3).
   */
  function pushBacklogBeyondTailWindow(log: EventLog, publisher: ConversationTopicPublisher): void {
    const firstTurn = log.events.filter(
      (event) => event.type === SessionEventType.TurnStarted,
    ).length;
    for (let index = 1; index <= 40; index += 1) {
      const turnNumber = firstTurn + index;
      const turnId = `backlog-${turnNumber}`;
      publisher.ingest(
        log.push(SessionEventType.TurnStarted, { turnNumber, input: `q${turnNumber}` }, { turnId }),
      );
      publisher.ingest(
        log.push(
          SessionEventType.ModelStreaming,
          { kind: "text_start", delta: "", done: false },
          { turnId },
        ),
      );
      publisher.ingest(
        log.push(
          SessionEventType.ModelStreaming,
          { kind: "text_delta", delta: "y".repeat(200), done: false },
          { turnId },
        ),
      );
      publisher.ingest(
        log.push(
          SessionEventType.TurnComplete,
          { response: "r", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
          { turnId },
        ),
      );
    }
  }

  it("overflow 后首次 flush 自动发最新 snapshot，随后从新水位续流", () => {
    const log = new EventLog();
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
      subscriberBufferMaxBytes: 500,
    });
    publisher.ingest(
      log.push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 1000,
      }),
    );
    const { ack } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });
    publisher.flush(ack.subscriptionId);

    pushBacklogBeyondTailWindow(log, publisher);
    const started = log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 99, input: "run" },
      { turnId: "turn-1" },
    );
    publisher.ingest(started);
    publisher.ingest(
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false },
        { turnId: "turn-1" },
      ),
    );
    const afterOverflow = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "after-overflow", done: false },
      { turnId: "turn-1" },
    );
    publisher.ingest(afterOverflow);

    const recovery = publisher.flush(ack.subscriptionId);
    expect(recovery?.payload.kind).toBe("snapshot");
    expect(recovery?.toSeq).toBe(afterOverflow.sequenceNumber);
    if (recovery?.payload.kind === "snapshot") {
      const rows = recovery.payload.snapshot.rows.window;
      expect(rows.length).toBe(PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
      expect(rows.at(-1)).toMatchObject({ kind: "assistantText", text: "after-overflow" });
    }

    const tail = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "tail", done: false },
      { turnId: "turn-1" },
    );
    publisher.ingest(tail);
    const resumed = publisher.flush(ack.subscriptionId);
    expect(resumed?.payload.kind).toBe("deltas");
    expect(resumed?.fromSeq).toBe(afterOverflow.sequenceNumber);
    expect(resumed?.toSeq).toBe(tail.sequenceNumber);
  });

  it("慢 subscriber overflow 只让自己 snapshot，快 subscriber 保持 delta", () => {
    const log = new EventLog();
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
      subscriberBufferMaxBytes: 500,
    });
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId: "turn-1" },
    );
    for (const event of log.events) publisher.ingest(event);
    const fast = publisher.subscribe({
      connectionId: "fast",
      deliveryProfile: "continuous",
    });
    const slow = publisher.subscribe({
      connectionId: "slow",
      deliveryProfile: "continuous",
    });

    publisher.flush(fast.ack.subscriptionId);
    publisher.flush(slow.ack.subscriptionId);
    publisher.ingest(
      log.push(
        SessionEventType.TurnComplete,
        { response: "r", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
        { turnId: "turn-1" },
      ),
    );
    const fastKinds: string[] = [];
    const ingest = publisher.ingest.bind(publisher);
    // fast flushes on every event; slow never flushes, letting the backlog exceed the tail window.
    publisher.ingest = (event) => {
      ingest(event);
      const frame = publisher.flush(fast.ack.subscriptionId);
      if (frame) fastKinds.push(frame.payload.kind);
    };
    pushBacklogBeyondTailWindow(log, publisher);

    expect(fastKinds.length).toBeGreaterThan(0);
    expect(fastKinds.every((kind) => kind === "deltas")).toBe(true);
    expect(publisher.flush(slow.ack.subscriptionId)?.payload.kind).toBe("snapshot");
  });

  it("字节上限 = min(max(下限, snapshot 上界), 16MiB - 64KiB)", () => {
    const floor = PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes;
    const cap = PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
    expect(conversationSubscriberBufferByteLimit(floor, 0)).toBe(floor);
    expect(conversationSubscriberBufferByteLimit(floor, floor - 1)).toBe(floor);
    expect(conversationSubscriberBufferByteLimit(floor, 3 * floor)).toBe(3 * floor);
    expect(conversationSubscriberBufferByteLimit(floor, cap + 1)).toBe(cap);
    expect(conversationSubscriberBufferByteLimit(500, 2_000)).toBe(2_000);

    const big = singleDeltaPayloadAtBytes(3 * floor);
    expect(appendConversationSubscriberBuffer([], [big])).toEqual({ kind: "overflow" });
    expect(
      appendConversationSubscriberBuffer([], [big], { snapshotBytesUpperBound: 3 * floor }),
    ).toMatchObject({ kind: "buffered", encodedBytes: 3 * floor });
    expect(
      appendConversationSubscriberBuffer([], [big], { snapshotBytesUpperBound: 3 * floor - 1 }),
    ).toEqual({ kind: "overflow" });
  });

  /**
   * Long-session regression (observed live 2026-09-30): a single large delta such as 3MiB of bash output exceeds the
   * 1MiB floor; the old rule downgraded to snapshot → the client replaced wholesale and lost history → the turn
   * navigator re-paginated from scratch every turn. The snapshot would only be larger (the same row is still in the
   * tail window), so deltas must keep flowing.
   */
  it("单条大 delta 超过 1MiB 但不超过 snapshot 上界：继续发 deltas，终态 ≡ 全量重放", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };
    for (const event of log.events) publisher.ingest(event);
    const { ack, frame } = publisher.subscribe({
      connectionId: "conn-1",
      deliveryProfile: "continuous",
    });
    clientApply(store, frame!);

    const turnId = "turn-big";
    for (const event of [
      log.push(SessionEventType.TurnStarted, { turnNumber: 3, input: "big" }, { turnId }),
      log.push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false },
        { turnId },
      ),
      log.push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "x".repeat(PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes + 512 * 1024),
          done: false,
        },
        { turnId },
      ),
    ]) {
      publisher.ingest(event);
    }
    const bigFrame = publisher.flush(ack.subscriptionId)!;
    expect(bigFrame.payload.kind).toBe("deltas");
    expect(utf8JsonByteLength(bigFrame.payload)).toBeGreaterThan(
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    );
    clientApply(store, bigFrame);

    const complete = log.push(
      SessionEventType.TurnComplete,
      { response: "r", tokenCount: 1, toolCallCount: 0, duration: 1, resultType: "success" },
      { turnId },
    );
    publisher.ingest(complete);
    const next = publisher.flush(ack.subscriptionId)!;
    expect(next.payload.kind).toBe("deltas");
    clientApply(store, next);
    expect(store.seq).toBe(complete.sequenceNumber);
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });

  it("profile filter 在计数前执行，被过滤 delta 不占 op 但 seq 继续推进", () => {
    const log = new EventLog();
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
      subscriberBufferMaxOps: 0,
    });
    log.push(SessionEventType.SessionCreated, {
      mode: "default",
      contextWindow: 1000,
    });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "write" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tc-1",
        toolName: "Write",
      },
      { turnId: "turn-1" },
    );
    for (const event of log.events) publisher.ingest(event);
    const { ack } = publisher.subscribe({ connectionId: "replayable" });

    const filtered = log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_delta",
        delta: '{"file_path":"a.ts"}',
        done: false,
        toolCallId: "tc-1",
      },
      { turnId: "turn-1" },
    );
    publisher.ingest(filtered);
    const frame = publisher.flush(ack.subscriptionId);
    expect(frame?.payload).toEqual({ kind: "deltas", deltas: [] });
    expect(frame?.toSeq).toBe(filtered.sequenceNumber);
  });
});

// ── M5④ R-06: snapshot tail window + rows/range cursor pagination ──
// Golden invariant: after backfilling the truncated snapshot's window with rows/range pages, it is byte-for-byte
// identical to the full replay's rows.window (same projection as the data source, guaranteed by construction;
// this test cross-validates with an independent replay).
describe("rows/range 游标分页（R-06）", () => {
  // 3 rows per turn (turnHeader+userInput+assistantText); 30 turns = 90 rows > 60.
  const TURNS = 30;

  function longPublisher(): {
    publisher: ConversationTopicPublisher;
    log: EventLog;
  } {
    const log = makeLog(TURNS);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    return { publisher, log };
  }

  it("超窗会话 snapshot 只带尾部 60 行；totalCount/firstRowId 保留全序口径", () => {
    const { publisher, log } = longPublisher();
    const full = authoritativeSnapshot(log.events);
    expect(full.rows.window.length).toBeGreaterThan(60);

    const { frame } = publisher.subscribe({ connectionId: "conn-1" });
    expect(frame!.payload.kind).toBe("snapshot");
    const wire = frame!.payload.kind === "snapshot" ? frame!.payload.snapshot : null;
    expect(wire!.rows.window.length).toBe(60);
    expect(wire!.rows.totalCount).toBe(full.rows.totalCount);
    expect(wire!.rows.firstRowId).toBe(full.rows.firstRowId);
    // Tail window = the full replay's last 60 rows (byte-for-byte identical).
    expect(wire!.rows.window).toEqual(full.rows.window.slice(-60));
    // Zone A is unaffected by truncation.
    expect({ ...wire!, rows: full.rows }).toEqual(full);
  });

  it("loadOlder 黄金路径：rows/range 各页 + 尾部窗口 ≡ 全量重放（逐字节）", () => {
    const { publisher, log } = longPublisher();
    const full = authoritativeSnapshot(log.events);
    const { frame } = publisher.subscribe({ connectionId: "conn-1" });
    const wire = frame!.payload.kind === "snapshot" ? frame!.payload.snapshot : null;

    // Simulate the client's loadOlder: page upward using the window's first row as the cursor until hasMore=false.
    let window = [...wire!.rows.window];
    let guard = 0;
    for (;;) {
      expect(guard++).toBeLessThan(20);
      const first = window[0]!;
      if (first.rowId === wire!.rows.firstRowId) break;
      const page = publisher.getRowsRange({
        beforeRowId: first.rowId,
        limit: 10,
      });
      expect(page.atLogEpoch).toBe("epoch-1");
      expect(page.atSeq).toBe(full.seq);
      expect(page.atRevision).toBe(full.revision);
      // Within a page rowIds ascend and are all < the cursor.
      for (let i = 0; i < page.rows.length; i++) {
        expect(page.rows[i]!.rowId).toBeLessThan(first.rowId);
        if (i > 0) {
          expect(page.rows[i]!.rowId).toBeGreaterThan(page.rows[i - 1]!.rowId);
        }
      }
      window = [...page.rows, ...window];
      if (!page.hasMore) {
        expect(window[0]!.rowId).toBe(wire!.rows.firstRowId);
      }
    }
    // Golden assertion: the backfilled window is byte-for-byte identical to the full replay.
    expect(JSON.stringify(window)).toBe(JSON.stringify(full.rows.window));
  });

  it("beforeRowId 缺省 = 从尾部向前；limit 截到 rowsRangeMaxLimit", () => {
    const { publisher, log } = longPublisher();
    const full = authoritativeSnapshot(log.events);

    const tail = publisher.getRowsRange({ limit: 5 });
    expect(tail.rows).toEqual(full.rows.window.slice(-5));
    expect(tail.hasMore).toBe(true);

    const all = publisher.getRowsRange({ limit: 10_000 });
    expect(all.rows.length).toBeLessThanOrEqual(200);
    expect(all.hasMore).toBe(full.rows.window.length > all.rows.length);
  });

  it("已到顶：beforeRowId = 全序首行 → 空页 hasMore=false", () => {
    const { publisher } = longPublisher();
    const snapshot = publisher.getSnapshot();
    const page = publisher.getRowsRange({
      beforeRowId: snapshot.rows.firstRowId!,
      limit: 10,
    });
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("短会话（≤60 行）snapshot 不截断，行为与既往一致", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const { frame } = publisher.subscribe({ connectionId: "conn-1" });
    const wire = frame!.payload.kind === "snapshot" ? frame!.payload.snapshot : null;
    expect(wire).toEqual(authoritativeSnapshot(log.events));
  });
});

describe("HK08 Hook lifecycle product delivery boundary", () => {
  const descriptor = {
    clientVisible: true as const,
    sourceKind: "user" as const,
    sourcePath: "/Users/example/.zcode/cli/config.json",
    executionType: "command" as const,
    executionMode: "foreground" as const,
    commandDisplay: "./hooks/check.sh",
    timeoutMs: 5_000,
  };

  function hookLifecycleLog(): EventLog {
    const log = new EventLog();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 1_000 });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "run" }, { turnId: "turn-1" });
    log.push(
      SessionEventType.HookRunStarted,
      {
        descriptor,
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "hook-invocation-1",
        hookRunId: "hook-run-1",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1" },
    );
    log.push(
      SessionEventType.HookRunCompleted,
      {
        descriptor,
        durationMs: 25,
        hookEventName: "UserPromptSubmit",
        hookIndex: 0,
        hookCount: 1,
        hookInvocationId: "hook-invocation-1",
        hookRunId: "hook-run-1",
        outcome: "success",
        startedAt: 1_700_000_003_000,
      },
      { turnId: "turn-1" },
    );
    return log;
  }

  it.each(["continuous", "replayable"] as const)(
    "%s snapshot(W) + resume(W,current] matches the full safe Hook projection",
    (deliveryProfile) => {
      const log = hookLifecycleLog();
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
        now: () => 1_700_000_999_000,
      });
      const store = { seq: 0, snapshot: null as ConversationSnapshot | null };

      for (const event of log.events.slice(0, 3)) publisher.ingest(event);
      const initial = publisher.subscribe({
        connectionId: `${deliveryProfile}-initial`,
        deliveryProfile,
      });
      expect(initial.ack.mode).toBe("snapshot");
      clientApply(store, initial.frame!);
      publisher.unsubscribe(initial.ack.subscriptionId);

      publisher.ingest(log.events[3]!);
      const resumed = publisher.subscribe({
        connectionId: `${deliveryProfile}-resume`,
        deliveryProfile,
        base: { logEpoch: "epoch-1", seq: store.seq },
      });
      expect(resumed.ack.mode).toBe("resume");
      clientApply(store, resumed.frame!);

      const fullFrame = publisher.subscribe({
        connectionId: `${deliveryProfile}-full`,
        deliveryProfile,
      }).frame!;
      expect(fullFrame.payload.kind).toBe("snapshot");
      if (fullFrame.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(store.snapshot).toEqual(fullFrame.payload.snapshot);
      expect(store.snapshot?.rows.window.some((row) => row.kind === "hookInvocation")).toBe(true);
      expect(JSON.stringify(store.snapshot)).not.toMatch(/commandDisplay|sourcePath/u);
    },
  );

  it("delivers the same safe summary through live, resume, snapshot, and rows/range", () => {
    const log = hookLifecycleLog();
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 1_700_000_999_000,
    });
    for (const event of log.events.slice(0, 2)) publisher.ingest(event);
    const desktop = publisher.subscribe({
      connectionId: "desktop",
      deliveryProfile: "continuous",
    });
    const replayable = publisher.subscribe({
      connectionId: "web",
      deliveryProfile: "replayable",
    });

    publisher.ingest(log.events[2]!);
    const desktopLive = publisher.flush(desktop.ack.subscriptionId);
    const replayableLive = publisher.flush(replayable.ack.subscriptionId);
    expect(desktopLive?.payload.kind).toBe("deltas");
    expect(
      desktopLive?.payload.kind === "deltas"
        ? desktopLive.payload.deltas.some(
            (delta) => delta.op === "row.appended" && delta.row.kind === "hookInvocation",
          )
        : false,
    ).toBe(true);
    expect(
      replayableLive?.payload.kind === "deltas"
        ? replayableLive.payload.deltas.some(
            (delta) =>
              (delta.op === "row.appended" || delta.op === "row.upserted") &&
              delta.row.kind === "hookInvocation",
          )
        : true,
    ).toBe(true);
    expect(replayableLive?.toSeq).toBe(log.events[2]!.sequenceNumber);

    publisher.ingest(log.events[3]!);
    publisher.unsubscribe(desktop.ack.subscriptionId);
    publisher.unsubscribe(replayable.ack.subscriptionId);
    const desktopResume = publisher.subscribe({
      connectionId: "desktop-resume",
      deliveryProfile: "continuous",
      base: { logEpoch: "epoch-1", seq: 2 },
    });
    const replayableResume = publisher.subscribe({
      connectionId: "web-resume",
      deliveryProfile: "replayable",
      base: { logEpoch: "epoch-1", seq: 2 },
    });
    expect(desktopResume.frame?.payload.kind).toBe("deltas");
    expect(
      desktopResume.frame?.payload.kind === "deltas"
        ? desktopResume.frame.payload.deltas.some(
            (delta) =>
              (delta.op === "row.appended" || delta.op === "row.upserted") &&
              delta.row.kind === "hookInvocation",
          )
        : false,
    ).toBe(true);
    expect(
      replayableResume.frame?.payload.kind === "deltas"
        ? replayableResume.frame.payload.deltas.some(
            (delta) =>
              (delta.op === "row.appended" || delta.op === "row.upserted") &&
              delta.row.kind === "hookInvocation",
          )
        : true,
    ).toBe(true);
    expect(replayableResume.frame?.toSeq).toBe(log.events[3]!.sequenceNumber);

    const desktopSnapshot = publisher.subscribe({
      connectionId: "desktop-snapshot",
      deliveryProfile: "continuous",
    }).frame;
    const webSnapshot = publisher.subscribe({
      connectionId: "web-snapshot",
      deliveryProfile: "replayable",
    }).frame;
    expect(
      desktopSnapshot?.payload.kind === "snapshot"
        ? desktopSnapshot.payload.snapshot.rows.window.some((row) => row.kind === "hookInvocation")
        : false,
    ).toBe(true);
    expect(
      webSnapshot?.payload.kind === "snapshot"
        ? webSnapshot.payload.snapshot.rows.window.some((row) => row.kind === "hookInvocation")
        : true,
    ).toBe(true);
    if (desktopSnapshot?.payload.kind === "snapshot" && webSnapshot?.payload.kind === "snapshot") {
      expect(desktopSnapshot.payload.snapshot.rows.totalCount).toBe(
        webSnapshot.payload.snapshot.rows.totalCount,
      );
    }

    expect(
      publisher
        .getRowsRange({ limit: 100 }, "continuous")
        .rows.some((row) => row.kind === "hookInvocation"),
    ).toBe(true);
    expect(
      publisher
        .getRowsRange({ limit: 100 }, "replayable")
        .rows.some((row) => row.kind === "hookInvocation"),
    ).toBe(true);
    expect(
      publisher.getRowsRange({ limit: 100 }).rows.some((row) => row.kind === "hookInvocation"),
    ).toBe(true);
  });
});

describe("会话计划目录（S13-S15）", () => {
  it("只返回当前分支已结束且包含正文的 ExitPlanMode，最新优先", () => {
    const log = new EventLog();
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    const turnId = "turn-plan-directory";
    const ingest = (event: SessionEvent) => publisher.ingest(event);
    ingest(log.push(SessionEventType.SessionCreated, { mode: "default" }));
    ingest(log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "写计划" }, { turnId }));

    const schedulePlan = (toolCallId: string, plan: string) => {
      ingest(
        log.push(
          SessionEventType.ModelStreaming,
          {
            kind: "tool_input_start",
            delta: "",
            done: false,
            toolCallId,
            toolName: "ExitPlanMode",
          },
          { turnId },
        ),
      );
      ingest(
        log.push(
          SessionEventType.ToolCallScheduled,
          {
            toolCallId,
            toolName: "ExitPlanMode",
            input: { plan },
            schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
          },
          { turnId },
        ),
      );
    };

    schedulePlan("plan-success", "# 成功计划");
    ingest(
      log.push(
        SessionEventType.ToolCallResult,
        {
          toolCallId: "plan-success",
          result: { success: true, content: "done" },
          duration: 10,
        },
        { turnId },
      ),
    );
    schedulePlan("plan-error", "# 失败计划");
    ingest(
      log.push(
        SessionEventType.ToolCallError,
        {
          toolCallId: "plan-error",
          error: { type: "fault.test", message: "failed" },
        },
        { turnId },
      ),
    );
    schedulePlan("plan-cancelled", "# 取消计划");

    expect(publisher.getPlans().plans.map((row) => row.toolCallId)).toEqual([
      "plan-error",
      "plan-success",
    ]);

    ingest(
      log.push(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 3,
          duration: 20,
          resultType: "cancelled",
        },
        { turnId },
      ),
    );
    const result = publisher.getPlans();
    expect(result.plans.map((row) => [row.toolCallId, row.status])).toEqual([
      ["plan-cancelled", "cancelled"],
      ["plan-error", "error"],
      ["plan-success", "success"],
    ]);
    expect(result.atSeq).toBe(log.events.at(-1)?.sequenceNumber);
    expect(result.atLogEpoch).toBe("epoch-1");
  });

  it("计划早于 wire snapshot tail 时仍从完整 projection 返回", () => {
    const log = new EventLog();
    const turnId = "turn-early-plan";
    log.push(SessionEventType.SessionCreated, { mode: "default" });
    log.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "早期计划" }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "early-plan",
        toolName: "ExitPlanMode",
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "early-plan",
        toolName: "ExitPlanMode",
        input: { plan: "# 早于尾窗的计划" },
        schedule: { parallelGroups: [["early-plan"]], executionOrder: ["early-plan"] },
      },
      { turnId },
    );
    log.push(
      SessionEventType.ToolCallResult,
      {
        toolCallId: "early-plan",
        result: { success: true, content: "done" },
        duration: 10,
      },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 1,
        duration: 20,
        resultType: "success",
      },
      { turnId },
    );
    for (let turn = 2; turn <= 32; turn += 1) turnEvents(log, turn);

    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
    });
    for (const event of log.events) publisher.ingest(event);
    const initial = publisher.subscribe({ connectionId: "wire-tail" }).frame;
    const wireRows =
      initial?.payload.kind === "snapshot" ? initial.payload.snapshot.rows.window : [];

    expect(wireRows).toHaveLength(PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
    expect(wireRows.some((row) => row.kind === "toolCall" && row.toolCallId === "early-plan")).toBe(
      false,
    );
    expect(publisher.getPlans().plans.map((row) => row.toolCallId)).toEqual(["early-plan"]);
  });
});
