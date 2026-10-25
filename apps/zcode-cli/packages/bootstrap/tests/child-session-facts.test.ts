// Unit tests for the bridge-level child-conversation facts resolver (spec:
// sidebar-child-conversation-counts.md §3, §9): TTL gating, stale-serve, failure backoff, cold-parent
// seeding, and live-registry side-chat parent discovery.
import { describe, expect, it, vi } from "vitest";
import type { ChildSessionInfo, SessionStorePort } from "@zcode/contracts";
import type { ZCodeProtocolSessionRecord } from "../src/zcode-protocol/server-types.js";
import {
  createChildSessionFactsResolver,
  type ChildSessionFactsResolver,
} from "../src/zcode-protocol-v4/child-session-facts.js";

function record(overrides: {
  sessionId: string;
  parentSessionId?: string;
  taskType?: string;
}): ZCodeProtocolSessionRecord {
  return {
    sessionId: overrides.sessionId,
    parentSessionId: overrides.parentSessionId,
    taskType: overrides.taskType,
  } as unknown as ZCodeProtocolSessionRecord;
}

function createHarness(
  initialCounts: Map<string, { sideChats: number }> = new Map(),
) {
  const sessions = new Map<string, ZCodeProtocolSessionRecord>();
  const children = new Map<string, ChildSessionInfo[]>();
  const clockMs = { value: 10_000 };
  const warnings: string[] = [];
  let shouldFail = false;
  const onRefresh = vi.fn();
  const store = {
    countChildSessions: vi.fn(async () => {
      if (shouldFail) throw new Error("store down");
      return new Map(initialCounts);
    }),
    listChildSessions: vi.fn(async () => {
      if (shouldFail) throw new Error("store down");
      return new Map(children);
    }),
  } as unknown as SessionStorePort;
  const resolver = createChildSessionFactsResolver({
    store: () => store,
    sessions,
    onRefresh,
    logger: { warn: (message: string) => warnings.push(message) },
    now: () => clockMs.value,
  });
  return {
    resolver,
    sessions,
    clockMs,
    warnings,
    countCalls: () => store.countChildSessions.mock.calls.length,
    listCalls: () => store.listChildSessions.mock.calls.length,
    failNextRefreshes: () => {
      shouldFail = true;
    },
    setChildren: (parentKey: string, ...items: ChildSessionInfo[]) => {
      children.set(parentKey, items);
    },
    onRefresh,
    setCount: (parentKey: string, value: { sideChats: number }) => {
      initialCounts.set(parentKey, value);
    },
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("child session facts resolver", () => {
  it("plain workspaces cost nothing: unknown parents resolve empty with no store reads", () => {
    const harness = createHarness();
    expect(harness.resolver.resolve("s-unknown")).toEqual({});
    expect(harness.countCalls()).toBe(0);
    expect(harness.listCalls()).toBe(0);
  });

  it("cold-seeded parents refresh once, serve stale within the TTL, and refresh again after it", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 1 }]]));
    harness.resolver.noteParents(["s-parent"]);
    // First resolve schedules the refresh; until it lands the cache is empty (stale-serve).
    expect(harness.resolver.resolve("s-parent")).toEqual({});
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);
    expect(harness.listCalls()).toBe(1);
    expect(harness.resolver.resolve("s-parent")).toEqual({ sideChatCount: 1 });

    // Within the TTL no further reads happen…
    harness.clockMs.value += 500;
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);

    // …after the TTL the next derive pass refreshes again.
    harness.clockMs.value += 600;
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(2);
  });

  it("does not requeue fresh parents when refresh publishes its result", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(new Map([['s-parent', { sideChats: 1 }]]));
      harness.onRefresh.mockImplementation((parentKeys: string[]) => {
        for (const parentKey of parentKeys) {
          harness.resolver.resolve(parentKey);
        }
      });
      harness.resolver.noteParents(["s-parent"]);
      harness.resolver.resolve("s-parent");
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.countCalls()).toBe(1);
      expect(harness.listCalls()).toBe(1);

      for (let elapsed = 0; elapsed < 3; elapsed += 1) {
        harness.clockMs.value += 1_001;
        await vi.advanceTimersByTimeAsync(1_001);
      }

      expect(harness.countCalls()).toBe(1);
      expect(harness.listCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers side-chat parents from live records; subagent records never register a parent", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 1 }]]));
    harness.sessions.set(
      "child-agent",
      record({ sessionId: "child-agent", parentSessionId: "s-other", taskType: "subagent_child" }),
    );
    harness.resolver.resolve("s-other");
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(0);

    harness.sessions.set(
      "child-chat",
      record({ sessionId: "child-chat", parentSessionId: "s-parent", taskType: "selection_side_chat" }),
    );
    harness.setChildren("s-parent", {
      id: "child-chat",
      title: "Side chat",
      taskType: "selection_side_chat",
      lastActivityAt: 10,
    });
    expect(harness.resolver.resolve("s-parent")).toEqual({});
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);
    expect(harness.resolver.resolve("s-parent")).toEqual({
      sideChatCount: 1,
      childSessions: [
        {
          sessionId: "child-chat",
          title: "Side chat",
          taskType: "selection_side_chat",
          lastActivityAt: 10,
          running: false,
        },
      ],
    });
  });

  it("seeds cold facts into the live cache and refreshes only invalidated parents", async () => {
    const harness = createHarness();
    const counts = new Map([["s-parent", { sideChats: 2 }]]);
    const children = new Map<string, ChildSessionInfo[]>([
      [
        "s-parent",
        [{ id: "child", title: "Child", taskType: "selection_side_chat", lastActivityAt: 5 }],
      ],
    ]);
    harness.resolver.seed(["s-parent"], counts, children);
    expect(harness.resolver.resolve("s-parent")).toEqual({
      sideChatCount: 2,
      childSessions: [
        {
          sessionId: "child",
          title: "Child",
          taskType: "selection_side_chat",
          lastActivityAt: 5,
          running: false,
        },
      ],
    });
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(0);

    harness.setCount("s-parent", { sideChats: 3 });
    harness.clockMs.value += 1_001;
    harness.resolver.invalidate(["s-parent"]);
    await harness.resolver.refresh(["s-parent"]);
    expect(harness.resolver.resolve("s-parent")).toMatchObject({ sideChatCount: 3 });
    expect(harness.onRefresh).toHaveBeenCalledWith(["s-parent"]);
    expect(harness.countCalls()).toBe(1);
  });

  it("keeps child-event invalidation store reads within the per-parent TTL", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 1 }]]));
    harness.resolver.seed(
      ["s-parent"],
      new Map([["s-parent", { sideChats: 1 }]]),
      new Map(),
    );
    harness.resolver.invalidate(["s-parent"]);
    await harness.resolver.refresh(["s-parent"]);
    expect(harness.countCalls()).toBe(0);

    harness.clockMs.value += 1_001;
    harness.resolver.invalidate(["s-parent"]);
    await harness.resolver.refresh(["s-parent"]);
    expect(harness.countCalls()).toBe(1);
  });

  it("automatically refreshes an invalidation deferred by the TTL", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(new Map([["s-parent", { sideChats: 1 }]]));
      harness.resolver.seed(
        ["s-parent"],
        new Map([["s-parent", { sideChats: 1 }]]),
        new Map(),
      );
      harness.resolver.invalidate(["s-parent"]);
      await harness.resolver.refresh(["s-parent"]);
      expect(harness.countCalls()).toBe(0);

      harness.clockMs.value += 1_001;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(harness.countCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing store backs off a full TTL instead of retrying on every fan-out", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 1 }]]));
    harness.resolver.noteParents(["s-parent"]);
    harness.failNextRefreshes();
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.warnings).toHaveLength(1);
    expect(harness.countCalls()).toBe(1);

    // Still inside the failure TTL window: no immediate retry.
    harness.clockMs.value += 100;
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);

    // After the TTL a retry is allowed again (still failing → warn again, still backed off).
    harness.clockMs.value += 1_000;
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(2);
    expect(harness.warnings).toHaveLength(2);
  });

  it("fetch batches both store reads for the cold path", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 3 }]]));
    const [counts] = await harness.resolver.loadStoredFacts(["s-parent"]);
    expect(counts.get("s-parent")).toEqual({ sideChats: 3 });
    expect(harness.listCalls()).toBe(1);
  });
});
