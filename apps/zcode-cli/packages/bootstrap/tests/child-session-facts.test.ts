// Unit tests for the bridge-level child-conversation facts resolver (spec:
// sidebar-child-conversation-counts.md §3): TTL gating, stale-serve, failure backoff, cold-parent
// seeding, live-registry parent discovery, and busy-based running facts.
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
  busy?: boolean;
}): ZCodeProtocolSessionRecord {
  return {
    sessionId: overrides.sessionId,
    parentSessionId: overrides.parentSessionId,
    taskType: overrides.taskType,
    activeAbortController: overrides.busy ? ({ abort: () => {} } as AbortController) : undefined,
    app: {
      runtime: { hasResidencyBlockingWork: () => overrides.busy === true },
    },
  } as unknown as ZCodeProtocolSessionRecord;
}

function createHarness(
  initialCounts: Map<string, { sideChats: number; subagents: number }> = new Map(),
) {
  const sessions = new Map<string, ZCodeProtocolSessionRecord>();
  const children = new Map<string, ChildSessionInfo[]>();
  const clockMs = { value: 10_000 };
  const warnings: string[] = [];
  let shouldFail = false;
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
    const harness = createHarness(new Map([["s-parent", { sideChats: 1, subagents: 2 }]]));
    harness.resolver.noteParents(["s-parent"]);
    // First resolve schedules the refresh; until it lands the cache is empty (stale-serve).
    expect(harness.resolver.resolve("s-parent")).toEqual({});
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);
    expect(harness.listCalls()).toBe(1);
    expect(harness.resolver.resolve("s-parent")).toEqual({ sideChatCount: 1, subagentCount: 2 });

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

  it("running facts come from busy registry children; resident-but-idle children never run", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 0, subagents: 2 }]]));
    // The registry scan discovers the parent (no cold seed) and counts only the busy subagent.
    harness.sessions.set(
      "child-busy",
      record({
        sessionId: "child-busy",
        parentSessionId: "s-parent",
        taskType: "subagent_child",
        busy: true,
      }),
    );
    harness.sessions.set(
      "child-idle",
      record({
        sessionId: "child-idle",
        parentSessionId: "s-parent",
        taskType: "subagent_child",
        busy: false,
      }),
    );
    expect(harness.resolver.resolve("s-parent")).toEqual({ runningSubagentCount: 1 });
    await flushMicrotasks();
    expect(harness.countCalls()).toBe(1);

    // Once the cached list lands, the busy child carries running=true, the idle one false, and a
    // resident side chat never does even while its record is busy.
    harness.setChildren(
      "s-parent",
      { id: "child-busy", title: "busy subagent", taskType: "subagent_child", lastActivityAt: 50 },
      { id: "child-idle", title: "idle subagent", taskType: "subagent_child", lastActivityAt: 40 },
      { id: "child-chat", title: "side chat", taskType: "selection_side_chat", lastActivityAt: 30 },
    );
    harness.sessions.set(
      "child-chat",
      record({
        sessionId: "child-chat",
        parentSessionId: "s-parent",
        taskType: "selection_side_chat",
        busy: true,
      }),
    );
    harness.clockMs.value += 1_500;
    harness.resolver.resolve("s-parent");
    await flushMicrotasks();
    expect(harness.resolver.resolve("s-parent")).toEqual({
      subagentCount: 2,
      runningSubagentCount: 1,
      childSessions: [
        {
          sessionId: "child-busy",
          title: "busy subagent",
          taskType: "subagent_child",
          lastActivityAt: 50,
          running: true,
        },
        {
          sessionId: "child-idle",
          title: "idle subagent",
          taskType: "subagent_child",
          lastActivityAt: 40,
          running: false,
        },
        {
          sessionId: "child-chat",
          title: "side chat",
          taskType: "selection_side_chat",
          lastActivityAt: 30,
          running: false,
        },
      ],
    });
  });

  it("a failing store backs off a full TTL instead of retrying on every fan-out", async () => {
    const harness = createHarness(new Map([["s-parent", { sideChats: 1, subagents: 0 }]]));
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
    const harness = createHarness(new Map([["s-parent", { sideChats: 3, subagents: 4 }]]));
    const [counts] = await harness.resolver.fetch(["s-parent"]);
    expect(counts.get("s-parent")).toEqual({ sideChats: 3, subagents: 4 });
    expect(harness.listCalls()).toBe(1);
  });
});
