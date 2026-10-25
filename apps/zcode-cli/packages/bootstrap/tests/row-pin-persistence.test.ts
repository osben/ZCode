import { describe, expect, it, vi } from "vitest";
import type {
  MessageInfo,
  SessionEvent,
  SessionEventStorePort,
  SessionStorePort,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { persistRowPinned } from "../src/zcode-protocol-v4/row-pin-persistence.js";

function messageInfo(role: "assistant" | "user"): MessageInfo {
  return {
    id: (role === "assistant" ? "assistant-1" : "user-1") as never,
    sessionID: "session-1" as never,
    role,
    time: { created: 1 },
    ...(role === "assistant" ? { parentID: "user-1" as never } : {}),
    ...(role === "assistant"
      ? { modelID: "model-1" as never, providerID: "provider-1" as never }
      : {}),
    mode: "default",
    agent: "default",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: { retained: "yes" },
  };
}

function buildStores(initial: MessageInfo) {
  let current = initial;
  const saveMessage = vi.fn(async (info: MessageInfo) => {
    current = info;
  });
  const sessionStore = {
    messages: vi.fn(async () => [{ info: current, parts: [] }]),
    saveMessage,
  } as unknown as SessionStorePort;
  const persistedEvents: SessionEvent[] = [];
  const eventStore = {
    getLatestSequenceNumber: vi.fn(async () => persistedEvents.length),
    append: vi.fn(async (event: SessionEvent) => {
      persistedEvents.push(event);
      return event;
    }),
  } as unknown as SessionEventStorePort;
  return { sessionStore, eventStore, saveMessage, persistedEvents, get current() { return current; } };
}

describe("row pin persistence", () => {
  it("pin 写 metadata.pinnedAt；幂等重复固定保留首次时间戳且不再发事件", async () => {
    const stores = buildStores(messageInfo("assistant"));
    const projected: SessionEvent[] = [];
    const common = {
      sessionStore: stores.sessionStore,
      eventStore: stores.eventStore,
      sessionId: "session-1",
      messageId: "assistant-1",
      entityId: "assistant-1",
      traceId: "trace-1",
      now: () => 100,
      onPersistedEvent: (event: SessionEvent) => projected.push(event),
    };

    await persistRowPinned({ ...common, pinned: true });
    expect(stores.current.metadata).toEqual({ retained: "yes", pinnedAt: 100 });
    expect(projected.at(-1)?.type).toBe(SessionEventType.RowPinnedUpdated);
    expect(projected.at(-1)?.payload).toEqual({ entityId: "assistant-1", pinnedAt: 100 });

    // 幂等：重复固定不覆盖首次 pinnedAt，也不追加 transcript/事件写入。
    const pinnedAtCalls = stores.saveMessage.mock.calls.length;
    await persistRowPinned({ ...common, now: () => 200, pinned: true });
    expect(stores.current.metadata).toEqual({ retained: "yes", pinnedAt: 100 });
    expect(stores.saveMessage).toHaveBeenCalledTimes(pinnedAtCalls);
    expect(projected.length).toBe(1);

    // 解固定删除 pinnedAt 并发布 null 事件；再次解固定是 no-op。
    await persistRowPinned({ ...common, pinned: false });
    expect(stores.current.metadata).toEqual({ retained: "yes" });
    expect(projected.at(-1)?.payload).toEqual({ entityId: "assistant-1", pinnedAt: null });
    const unpinnedCalls = stores.saveMessage.mock.calls.length;
    await persistRowPinned({ ...common, pinned: false });
    expect(stores.saveMessage).toHaveBeenCalledTimes(unpinnedCalls);
    expect(projected.length).toBe(2);
  });

  it("user 角色消息同样可以固定", async () => {
    const stores = buildStores(messageInfo("user"));
    const projected: SessionEvent[] = [];
    await persistRowPinned({
      sessionStore: stores.sessionStore,
      eventStore: stores.eventStore,
      sessionId: "session-1",
      messageId: "user-1",
      entityId: "user-1",
      pinned: true,
      traceId: "trace-1",
      now: () => 300,
      onPersistedEvent: (event: SessionEvent) => projected.push(event),
    });
    expect(stores.current.metadata).toEqual({ retained: "yes", pinnedAt: 300 });
    expect(projected.at(-1)?.payload).toEqual({ entityId: "user-1", pinnedAt: 300 });
  });

  it("event append 失败时补偿 transcript；durable 后 projection 失败不返回失败 ACK", async () => {
    const initial = messageInfo("assistant");
    const stores = buildStores(initial);
    const appendError = new Error("append failed");
    const failingEventStore = {
      getLatestSequenceNumber: vi.fn(async () => 0),
      append: vi.fn(async () => {
        throw appendError;
      }),
    } as unknown as SessionEventStorePort;

    await expect(
      persistRowPinned({
        sessionStore: stores.sessionStore,
        eventStore: failingEventStore,
        sessionId: "session-1",
        messageId: "assistant-1",
        entityId: "assistant-1",
        pinned: true,
        traceId: "trace-1",
        now: () => 100,
        onPersistedEvent: () => undefined,
      }),
    ).rejects.toBe(appendError);
    expect(stores.current).toEqual(initial);
    expect(stores.saveMessage).toHaveBeenCalledTimes(2);

    const persistedEventStore = {
      getLatestSequenceNumber: vi.fn(async () => 0),
      append: vi.fn(async (event: SessionEvent) => event),
    } as unknown as SessionEventStorePort;
    const onLiveProjectionError = vi.fn();
    await expect(
      persistRowPinned({
        sessionStore: stores.sessionStore,
        eventStore: persistedEventStore,
        sessionId: "session-1",
        messageId: "assistant-1",
        entityId: "assistant-1",
        pinned: true,
        traceId: "trace-1",
        now: () => 400,
        onPersistedEvent: () => {
          throw new Error("live projection failed");
        },
        onLiveProjectionError,
      }),
    ).resolves.toBeUndefined();
    expect(stores.current.metadata).toEqual({ retained: "yes", pinnedAt: 400 });
    expect(onLiveProjectionError).toHaveBeenCalledOnce();
  });
});
