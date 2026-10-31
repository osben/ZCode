/**
 * Process-level concurrency governor (docs/dynamic-workflow/concurrency.md "The governor"):
 * bucketing by provider key, admission **per model request** (tryAdmit fast path / admit
 * queueing), round-robin across runs, status-event mapping and dedup on tickets, epoch damping,
 * cap-change fan-out, Retry-After cooldown wake-ups, idle reset, and the main-agent observer.
 * The controller is real (a pure AIMD state machine); clocks and timers are injected.
 */

import { describe, expect, it } from "vitest";
import type {
  ModelNetworkStatusEvent,
  ModelRef,
  ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import type { ConcurrencyChange } from "@zcode/dynamic-workflow";
import {
  createWorkflowConcurrencyGovernor,
  workflowConcurrencyKey,
} from "../src/app/workflow-concurrency-governor.js";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_DEFAULT_CONCURRENCY_MAX,
} from "../src/app/workflow-default-concurrency.js";

const MODEL_A = { providerId: "prov", modelId: "alpha" } as unknown as ModelRef;
const MODEL_B = { providerId: "prov", modelId: "beta" } as unknown as ModelRef;
const KEY_A = workflowConcurrencyKey(MODEL_A);
const KEY_B = workflowConcurrencyKey(MODEL_B);
const CEILING = 8;

/** Fake clock + fake timers: the governor's only I/O surface. */
function fakeClock() {
  let current = 1_000_000;
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
  return {
    now: () => current,
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { at: current + delayMs, fire: callback, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Advance the clock and fire due timers. */
    advance(ms: number) {
      current += ms;
      for (const entry of [...timers]) {
        if (entry.cancelled || entry.at > current) continue;
        timers.splice(timers.indexOf(entry), 1);
        entry.fire();
      }
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

function statusEvent(
  partial: Partial<ModelNetworkStatusEvent> & { type: ModelNetworkStatusEvent["type"] },
  model: ModelRef = MODEL_A,
): ModelNetworkStatusEvent {
  return {
    timestamp: new Date(0).toISOString(),
    traceId: "trace",
    requestId: "req",
    model,
    transport: "http",
    attempt: 1,
    maxAttempts: 0,
    ...partial,
  } as unknown as ModelNetworkStatusEvent;
}

/** Four endings of one attempt, fed to the ticket in the event sequence the runner actually emits. */
const outcome = {
  started: (ticket: ModelRequestAdmissionTicket, model = MODEL_A) =>
    ticket.publish(statusEvent({ type: "model_request_started" }, model)),
  completed: (ticket: ModelRequestAdmissionTicket, model = MODEL_A) => {
    outcome.started(ticket, model);
    void ticket.publish(
      statusEvent({ type: "model_request_completed", durationMs: 1 } as never, model),
    );
  },
  /** A full 429: the runner emits failed(retryable:true) then retry_scheduled (what decision 27 deduplicates). */
  throttled429: (ticket: ModelRequestAdmissionTicket, retryAfterMs?: number, model = MODEL_A) => {
    outcome.started(ticket, model);
    void ticket.publish(
      statusEvent(
        {
          type: "model_request_failed",
          reason: "rate_limited",
          retryable: true,
          message: "429",
        } as never,
        model,
      ),
    );
    void ticket.publish(
      statusEvent(
        {
          type: "model_retry_scheduled",
          reason: "rate_limited",
          delayMs: 2000,
          nextAttempt: 2,
          message: "429",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        } as never,
        model,
      ),
    );
  },
  retryScheduled: (
    ticket: ModelRequestAdmissionTicket,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_retry_scheduled",
        reason,
        delayMs: 1000,
        nextAttempt: 2,
        message: reason,
        ...extra,
      } as never),
    );
  },
  permanent: (ticket: ModelRequestAdmissionTicket) => {
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_request_failed",
        reason: "auth_failed",
        retryable: false,
        message: "401",
      } as never),
    );
  },
};

function makeGovernor(defaultConcurrency = CEILING) {
  const clock = fakeClock();
  const governor = createWorkflowConcurrencyGovernor({
    defaultConcurrency,
    now: clock.now,
    schedule: clock.schedule,
  });
  /** The fast path must hit (test precondition: gate open, nobody queued); otherwise the test itself is wrong. */
  const admitNow = (runId = "runA", key = KEY_A): ModelRequestAdmissionTicket => {
    const ticket = governor.tryAdmit(runId, key);
    if (ticket === undefined) throw new Error("tryAdmit unexpectedly missed");
    return ticket;
  };
  /** Main-agent path: the observer admits immediately. */
  const observe = async (model = MODEL_A) => governor.observer().acquire({ model });
  return { clock, governor, admitNow, observe };
}

/** Observation surface for whether an admit settles immediately (without awaiting the pending promise). */
function track(promise: Promise<ModelRequestAdmissionTicket>) {
  const state: { ticket?: ModelRequestAdmissionTicket; error?: unknown; settled: boolean } = {
    settled: false,
  };
  promise.then(
    (ticket) => {
      state.ticket = ticket;
      state.settled = true;
    },
    (error) => {
      state.error = error;
      state.settled = true;
    },
  );
  return state;
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe("resolveWorkflowDefaultConcurrency", () => {
  it("地板为 4（双核与四核都是 4），8 核为 6，18 核及以上顶在 16", () => {
    expect(resolveWorkflowDefaultConcurrency(() => 1)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 2)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 4)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 6)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 8)).toBe(6);
    expect(resolveWorkflowDefaultConcurrency(() => 10)).toBe(8);
    expect(resolveWorkflowDefaultConcurrency(() => 18)).toBe(WORKFLOW_DEFAULT_CONCURRENCY_MAX);
    expect(resolveWorkflowDefaultConcurrency(() => 64)).toBe(16);
  });
});

describe("workflow concurrency governor — 桶与闸门（决策 34）", () => {
  it("首个 run 从天花板起步：ceiling 个 tryAdmit 命中，第 ceiling+1 个未命中并在 admit 里等待", async () => {
    const { governor, admitNow } = makeGovernor();
    const tickets = Array.from({ length: CEILING }, () => admitNow());
    expect(governor.tryAdmit("runA", KEY_A)).toBeUndefined();
    const waiting = track(governor.admit("runA", KEY_A, new AbortController().signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: CEILING, inFlight: CEILING, waiters: 1 });

    // One attempt ends (success), releasing a slot and waking a waiter.
    outcome.completed(tickets[0]!);
    await flush();
    expect(waiting.ticket).toBeDefined();
    expect(governor.snapshot(KEY_A)).toMatchObject({ inFlight: CEILING, waiters: 0 });
  });

  it("tryAdmit 的公平性：有人排队时即便闸门开着也不走快路径（决策 9）", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const first = admitNow("A");
    const waiting = track(governor.admit("B", KEY_A, new AbortController().signal));
    await flush();
    // Releasing first opens the gate for a moment: queued B gets it first; A's next tryAdmit cannot overtake B.
    outcome.completed(first);
    await flush();
    expect(waiting.ticket).toBeDefined();
    expect(governor.tryAdmit("A", KEY_A)).toBeUndefined();
    const another = track(governor.admit("A", KEY_A, new AbortController().signal));
    await flush();
    expect(another.settled).toBe(false);
    // While A is queued, the fast path stays closed for every run even if the gate opens.
    outcome.completed(waiting.ticket!);
    await flush();
    expect(another.ticket).toBeDefined();
  });

  it("主代理（observer）的 429 把桶压到 4 后，新 run 直接从 4 起步（决策 10/19/37）", async () => {
    const { governor, observe } = makeGovernor();
    const main = await observe();
    outcome.throttled429(main);
    expect(governor.snapshot(KEY_A)?.cap).toBe(6); // 8 × 0.75

    const hits = Array.from({ length: 7 }, () => governor.tryAdmit("runB", KEY_A));
    expect(hits.filter((t) => t !== undefined)).toHaveLength(6);
    expect(hits[6]).toBeUndefined();
  });

  it("observer 的 tryAcquire 总命中且计入 inFlight（v3 决策 44/47）：主代理的工具与 sidecar 请求从不排队、从不发 queued", async () => {
    const clock = fakeClock();
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency: 2,
      now: clock.now,
      schedule: clock.schedule,
    });
    const first = governor.observer().tryAcquire!({ model: MODEL_A });
    const second = governor.observer().tryAcquire!({ model: MODEL_A });
    const third = governor.observer().tryAcquire!({ model: MODEL_A });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Gate already full (2/2): the observer still hits the fast path.
    expect(third).toBeDefined();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(3);
    // A workflow request cannot take the fast path right now.
    expect(governor.tryAdmit("run-x", KEY_A)).toBeUndefined();
    first!.release();
    second!.release();
    third!.release();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("observer 不排队、不看冷却，但计入 inFlight（决策 37）", async () => {
    const { governor, observe, admitNow, clock } = makeGovernor(1);
    const busy = admitNow("A");
    // Gate already full: the observer still admits immediately.
    const main = await observe();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(2);
    outcome.throttled429(main, 30_000);
    expect(governor.snapshot(KEY_A)?.cooldownUntil).toBe(clock.now() + 30_000);
    // During cooldown: the observer still admits; workflow requests cannot.
    const again = await observe();
    expect(again).toBeDefined();
    expect(governor.tryAdmit("A", KEY_A)).toBeUndefined();
    outcome.completed(busy);
    outcome.completed(again);
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("按 key 分桶：alpha 被限流不影响 beta", async () => {
    const { governor, observe } = makeGovernor();
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)?.cap).toBe(6);
    expect(governor.snapshot(KEY_B)).toBeUndefined();
    const hits = Array.from({ length: CEILING }, () => governor.tryAdmit("runB", KEY_B));
    expect(hits.every((t) => t !== undefined)).toBe(true);
    expect(governor.snapshot(KEY_B)?.cap).toBe(CEILING);
  });

  it("run 间轮转：A 排 10 个、B 排 1 个，B 的第一个不晚于 A 的第二个（决策 9）", async () => {
    const { governor } = makeGovernor(1);
    const order: string[] = [];
    const tickets: ModelRequestAdmissionTicket[] = [];
    const enqueue = (runId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        void governor.admit(runId, KEY_A, new AbortController().signal).then((ticket) => {
          order.push(runId);
          tickets.push(ticket);
        });
      }
    };
    enqueue("A", 10);
    enqueue("B", 1);
    await flush();
    // cap=1: A (first to arrive) is admitted first; after it ends, it is B's turn — not A's second request.
    expect(order).toEqual(["A"]);
    outcome.completed(tickets.shift()!);
    await flush();
    expect(order).toEqual(["A", "B"]);
    outcome.completed(tickets.shift()!);
    await flush();
    expect(order).toEqual(["A", "B", "A"]);
  });

  it("signal abort 把等待者移出队列并以 signal.reason reject", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const first = admitNow("A");
    const controller = new AbortController();
    const waiting = track(governor.admit("A", KEY_A, controller.signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(governor.snapshot(KEY_A)?.waiters).toBe(1);

    controller.abort(new Error("run cancelled"));
    await flush();
    expect(waiting.error).toBeInstanceOf(Error);
    expect((waiting.error as Error).message).toBe("run cancelled");
    expect(governor.snapshot(KEY_A)?.waiters).toBe(0);
    // The first one ends: nobody else is admitted (waiters already left), and the slot stays open.
    outcome.completed(first);
    await flush();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("已 abort 的 signal 立即 reject", async () => {
    const { governor } = makeGovernor();
    const controller = new AbortController();
    controller.abort();
    await expect(governor.admit("A", KEY_A, controller.signal)).rejects.toBeInstanceOf(Error);
  });

  it("Retry-After 冷却冻结新准入直到 deadline，定时器到期唤醒等待者（决策 11）", async () => {
    const { governor, clock, observe } = makeGovernor();
    outcome.throttled429(await observe(), 20_000);
    const snapshot = governor.snapshot(KEY_A)!;
    expect(snapshot.cap).toBe(6);
    expect(snapshot.cooldownUntil).toBe(clock.now() + 20_000);

    expect(governor.tryAdmit("A", KEY_A)).toBeUndefined();
    const waiting = track(governor.admit("A", KEY_A, new AbortController().signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(clock.pendingTimers()).toBe(1);

    clock.advance(19_999);
    await flush();
    expect(waiting.settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(waiting.ticket).toBeDefined();
  });
});

describe("workflow concurrency governor — 主代理 subagent 池（docs/dynamic-workflow/concurrency.md「Where the port is bound」）", () => {
  // Fix reason: subagents used to inherit the parent's observer — parallel Agent calls neither
  // queued nor respected Retry-After, the largest source of production 1302 storms.

  it("受闸门约束：cap 满时快路径未命中，acquire 排队到有名额", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const pool = governor.sessionSubagents("session-1");
    const busy = admitNow("A");
    expect(pool.tryAcquire!({ model: MODEL_A })).toBeUndefined();
    const waiting = track(pool.acquire({ model: MODEL_A }));
    await flush();
    expect(waiting.settled).toBe(false);
    outcome.completed(busy);
    await flush();
    expect(waiting.ticket).toBeDefined();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(1);
  });

  it("看冷却：主代理撞出的 Retry-After 冻结 subagent，到期唤醒；主代理（observer）照常放行", async () => {
    const { governor, clock, observe } = makeGovernor();
    outcome.throttled429(await observe(), 20_000);
    const pool = governor.sessionSubagents("session-1");
    expect(pool.tryAcquire!({ model: MODEL_A })).toBeUndefined();
    const waiting = track(pool.acquire({ model: MODEL_A }));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(await observe()).toBeDefined();
    clock.advance(20_000);
    await flush();
    expect(waiting.ticket).toBeDefined();
  });

  it("喂信号：subagent 的 429 同样压低 cap、设冷却", async () => {
    const { governor, clock } = makeGovernor();
    const ticket = governor.sessionSubagents("session-1").tryAcquire!({ model: MODEL_A })!;
    outcome.throttled429(ticket, 10_000);
    expect(governor.snapshot(KEY_A)?.cap).toBe(6);
    expect(governor.snapshot(KEY_A)?.cooldownUntil).toBe(clock.now() + 10_000);
  });

  it("同一父会话的 subagent 共用一条队列，在轮转里只占一份：workflow run 不被饿死", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const busy = admitNow("runA");
    const order: string[] = [];
    const tickets: ModelRequestAdmissionTicket[] = [];
    const record = (label: string) => (ticket: ModelRequestAdmissionTicket) => {
      order.push(label);
      tickets.push(ticket);
    };
    // Two subagents of one session each want 2 requests — 4 waiters total; the workflow run queues only 1.
    for (const pool of [governor.sessionSubagents("s1"), governor.sessionSubagents("s1")]) {
      void pool.acquire({ model: MODEL_A }).then(record("sub"));
      void pool.acquire({ model: MODEL_A }).then(record("sub"));
    }
    void governor.admit("runA", KEY_A, new AbortController().signal).then(record("wf"));
    await flush();
    outcome.completed(busy);
    await flush();
    outcome.completed(tickets.shift()!);
    await flush();
    // Round-robin works by run identity: the four subagent requests count as one run, so the second slot goes to the workflow.
    expect(order).toEqual(["sub", "wf"]);
  });

  it("不同父会话各自一份：s1 排 2 个、s2 排 1 个，s2 的第一个不晚于 s1 的第二个", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const busy = admitNow("A");
    const order: string[] = [];
    const tickets: ModelRequestAdmissionTicket[] = [];
    const enqueue = (sessionId: string) =>
      void governor
        .sessionSubagents(sessionId)
        .acquire({ model: MODEL_A })
        .then((ticket) => {
          order.push(sessionId);
          tickets.push(ticket);
        });
    enqueue("s1");
    enqueue("s1");
    enqueue("s2");
    await flush();
    outcome.completed(busy);
    await flush();
    outcome.completed(tickets.shift()!);
    await flush();
    expect(order).toEqual(["s1", "s2"]);
  });

  it("signal abort 把等待中的 subagent 请求移出队列", async () => {
    const { governor, admitNow } = makeGovernor(1);
    admitNow("A");
    const controller = new AbortController();
    const waiting = track(
      governor.sessionSubagents("s1").acquire({ model: MODEL_A, signal: controller.signal }),
    );
    await flush();
    expect(governor.snapshot(KEY_A)?.waiters).toBe(1);
    controller.abort(new Error("user cancelled"));
    await flush();
    expect((waiting.error as Error).message).toBe("user cancelled");
    expect(governor.snapshot(KEY_A)?.waiters).toBe(0);
  });

  it("不抬增长上限：subagent 池不进桶的 runs，登记了大上界的 run 也只抬它自己用过的 key", () => {
    const { governor } = makeGovernor();
    governor.setRunBound("big", 40);
    void governor.sessionSubagents("s1").tryAcquire!({ model: MODEL_A });
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(2 * CEILING);
  });
});

describe("workflow concurrency governor — ticket 上的事件映射（决策 27/36）", () => {
  it("一次 429 = failed(retryable:true) + retry_scheduled，只算一次 throttled（不减两次）", async () => {
    const { governor, observe } = makeGovernor();
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0 });
  });

  it("retryable:false 的 rate_limited failed（主对话 / 工具侧撞 3008）→ 一次 throttled（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
    const { governor, admitNow, clock } = makeGovernor();
    const ticket = admitNow();
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_request_failed",
        reason: "rate_limited",
        retryable: false,
        message: "[3008] user concurrency limit exceeded",
        errorCode: "model_rate_limited",
        providerErrorCode: "3008",
        retryAfterMs: 5_000,
      } as never),
    );
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      cap: 6,
      cooldownUntil: clock.now() + 5_000,
    });
  });

  // Quota 429s (1308 + Retry-After) belong to the Stop set: the run stops and the user decides
  // when to retry. If they were recorded as throttling, the Retry-After (often pointing to the
  // quota window's end) would freeze the whole bucket, and after the user restores quota with a
  // reset card, resume would still be stuck at the gate.
  it.each([
    ["run 的 ticket", "run"],
    ["主代理 observer 的 ticket", "observer"],
  ] as const)(
    "Stop 集失败（配额 1308 带 Retry-After，来自%s）不动 cap 也不冷却：resume 立即准入（docs/dynamic-workflow/concurrency.md「Reading a ticket」）",
    async (_label, source) => {
      const { governor, admitNow, observe } = makeGovernor();
      const ticket = source === "run" ? admitNow() : await observe();
      outcome.started(ticket);
      void ticket.publish(
        statusEvent({
          type: "model_request_failed",
          reason: "rate_limited",
          retryable: false,
          message: "[1308] 已达到 5 小时的使用上限",
          errorCode: "model_rate_limited",
          providerErrorCode: "1308",
          retryAfterMs: 3 * 60 * 60 * 1000,
        } as never),
      );
      const snapshot = governor.snapshot(KEY_A)!;
      expect(snapshot).toMatchObject({ inFlight: 0, cap: CEILING });
      expect(snapshot.cooldownUntil).toBeUndefined();
      expect(governor.tryAdmit("resumed-run", KEY_A)).toBeDefined();
    },
  );

  it("retryable:false 的 failed 只减 inFlight，不动 cap 与 streak", () => {
    const { governor, admitNow } = makeGovernor();
    for (let i = 0; i < 3; i++) outcome.completed(admitNow());
    const before = governor.snapshot(KEY_A)!.successStreak;
    const ticket = admitNow();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(1);
    outcome.permanent(ticket);
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      cap: CEILING,
      successStreak: before,
    });
  });

  it("reasoning_signature_repair / auth_refresh 不是 provider 失败：cap 与 streak 都不动，只终结尝试", () => {
    const { governor, admitNow } = makeGovernor();
    for (let i = 0; i < 3; i++) outcome.completed(admitNow());
    const before = governor.snapshot(KEY_A)!.successStreak;
    outcome.retryScheduled(admitNow(), "reasoning_signature_repair", { delayMs: 0 });
    outcome.retryScheduled(admitNow(), "auth_refresh", { delayMs: 0 });
    expect(governor.snapshot(KEY_A)).toMatchObject({
      cap: CEILING,
      successStreak: before,
      inFlight: 0,
    });
  });

  it("offpeak_queued 归 throttled：减 cap 并按 Retry-After 冷却", () => {
    const { governor, admitNow, clock } = makeGovernor();
    outcome.retryScheduled(admitNow(), "offpeak_queued", { retryAfterMs: 60_000, delayMs: 60_000 });
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, cooldownUntil: clock.now() + 60_000 });
  });

  it("timeout / 5xx 的 retry_scheduled 只清 streak，不减 cap（决策 6）", () => {
    const { governor, admitNow } = makeGovernor();
    outcome.completed(admitNow());
    outcome.retryScheduled(admitNow(), "server_error");
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: CEILING, successStreak: 0, inFlight: 0 });
  });

  it("release() 没见终结事件即 ended；重复 release 幂等；结算后的 publish 惰性", () => {
    const { governor, admitNow } = makeGovernor();
    outcome.completed(admitNow());
    const streak = governor.snapshot(KEY_A)!.successStreak;
    const ticket = admitNow();
    outcome.started(ticket);
    ticket.release();
    ticket.release();
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      successStreak: streak,
      cap: CEILING,
    });
    // Already settled: feeding another 429 does not decrement.
    void ticket.publish(
      statusEvent({
        type: "model_retry_scheduled",
        reason: "rate_limited",
        delayMs: 2000,
        nextAttempt: 2,
        message: "429",
      } as never),
    );
    expect(governor.snapshot(KEY_A)).toMatchObject({ inFlight: 0, cap: CEILING });
    // A release after the terminal event no longer decrements either.
    const second = admitNow();
    outcome.completed(second);
    second.release();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });
});

describe("workflow concurrency governor — epoch 阻尼（决策 35）", () => {
  it("同一批准入的 8 个 429 只减一次、只发一条事件；再减只能来自新 epoch 的请求", async () => {
    const { governor, admitNow } = makeGovernor();
    const seen: ConcurrencyChange[] = [];
    governor.subscribe("runA", (change) => seen.push(change));
    const batch = Array.from({ length: CEILING }, () => admitNow());
    for (const ticket of batch) outcome.throttled429(ticket);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0, epoch: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ previous: CEILING, next: 6, reason: "rate_limited" });

    // Only requests issued in the new epoch hitting the wall count as feedback on cap=6.
    outcome.throttled429(admitNow());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 4, epoch: 2 });
    expect(seen).toHaveLength(2);
  });

  it("旧 epoch 的成功不计 streak；当前 epoch 连续 K = 4 次成功且有等待者才 +1", async () => {
    const { governor, admitNow } = makeGovernor(2);
    const stale = [admitNow(), admitNow()];
    // One of the two in-flight 429s: cap 2→1, and the other becomes old-epoch.
    outcome.throttled429(stale[0]!);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 1, inFlight: 1 });
    // Keep one waiter queued (decision 15: cap grows only with demand).
    const waiting = track(governor.admit("runA", KEY_A, new AbortController().signal));
    await flush();
    outcome.completed(stale[1]!);
    expect(governor.snapshot(KEY_A)?.successStreak).toBe(0);
    await flush();
    // The waiter gets a slot (inFlight 1 == cap 1); from here each completion backfills one waiter, accumulating 4 current-epoch successes.
    expect(waiting.ticket).toBeDefined();
    let current = waiting.ticket!;
    for (let i = 0; i < 3; i++) {
      const next = track(governor.admit("runA", KEY_A, new AbortController().signal));
      outcome.completed(current);
      await flush();
      expect(next.ticket).toBeDefined();
      current = next.ticket!;
    }
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 1, successStreak: 3 });
    const last = track(governor.admit("runA", KEY_A, new AbortController().signal));
    outcome.completed(current);
    await flush();
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 2, successStreak: 0 });
    expect(last.ticket).toBeDefined();
  });
});

describe("workflow concurrency governor — 扇出与遗忘", () => {
  it("cap 变化只扇出给该 key 上有在飞或排队请求的 run（决策 8）", async () => {
    const { governor, admitNow, observe } = makeGovernor();
    const seenA: ConcurrencyChange[] = [];
    const seenB: ConcurrencyChange[] = [];
    const seenC: ConcurrencyChange[] = [];
    governor.subscribe("A", (change) => seenA.push(change));
    governor.subscribe("B", (change) => seenB.push(change));
    governor.subscribe("C", (change) => seenC.push(change));
    // A has in-flight requests on alpha; B only subscribed; C has in-flight requests on beta.
    const a = admitNow("A", KEY_A);
    admitNow("C", KEY_B);

    outcome.throttled429(await observe(), 5_000);
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({
      key: KEY_A,
      previous: CEILING,
      next: 6,
      reason: "rate_limited",
      cooldownMs: 5_000,
    });
    expect(seenB).toEqual([]);
    expect(seenC).toEqual([]);
    outcome.completed(a);
  });

  it("排队中的 run 也收扇出；退订后不再收到", async () => {
    const { governor, admitNow, observe } = makeGovernor(1);
    const seen: ConcurrencyChange[] = [];
    const unsubscribe = governor.subscribe("A", (change) => seen.push(change));
    const busy = admitNow("B");
    track(governor.admit("A", KEY_A, new AbortController().signal));
    await flush();
    outcome.throttled429(await observe(), 1_000);
    expect(seen).toHaveLength(1);
    unsubscribe();
    outcome.throttled429(await observe(), 1_000);
    expect(seen).toHaveLength(1);
    outcome.completed(busy);
  });

  it("空闲 5 分钟且无在飞后，下一个 run 从天花板起步（决策 20）", async () => {
    const { governor, clock, observe, admitNow } = makeGovernor();
    outcome.completed(await observe());
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0 });

    clock.advance(300_000);
    const hits = Array.from({ length: CEILING }, () => governor.tryAdmit("runNext", KEY_A));
    expect(hits.every((t) => t !== undefined)).toBe(true);
    expect(governor.snapshot(KEY_A)?.cap).toBe(CEILING);
    for (const t of hits) outcome.completed(t!);
    void admitNow;
  });

  it("有在飞请求时不重置：5 分钟后 cap 仍是学到的值", async () => {
    const { governor, clock, observe, admitNow } = makeGovernor();
    const busy = admitNow();
    outcome.throttled429(await observe());
    clock.advance(300_000);
    expect(governor.tryAdmit("runA", KEY_A)).toBeDefined();
    expect(governor.snapshot(KEY_A)?.cap).toBe(6);
    outcome.completed(busy);
  });
});

describe("workflow concurrency governor — 增长上限（docs/dynamic-workflow/concurrency.md「The governor」）", () => {
  /** Keep one waiter for the run on the key and accumulate n current-epoch successes; returns the tickets still in flight. */
  async function climb(
    governor: ReturnType<typeof makeGovernor>["governor"],
    runId: string,
    tickets: ModelRequestAdmissionTicket[],
    successes: number,
  ): Promise<ModelRequestAdmissionTicket[]> {
    let live = [...tickets];
    for (let i = 0; i < successes; i++) {
      const next = track(governor.admit(runId, KEY_A, new AbortController().signal));
      const done = live.shift()!;
      outcome.completed(done);
      await flush();
      // The waiter may be admitted (cap allows) or still queued; admitted tickets join the in-flight set.
      if (next.ticket !== undefined) live.push(next.ticket);
      // Each round backfills everything admissible, keeping "someone waiting" true.
      for (;;) {
        const extra = governor.tryAdmit(runId, KEY_A);
        if (extra === undefined) break;
        live.push(extra);
      }
    }
    return live;
  }

  it("桶从 D 起步，自动增长停在 2D", async () => {
    const { governor, admitNow } = makeGovernor(4);
    const tickets = Array.from({ length: 4 }, () => admitNow("A"));
    expect(governor.snapshot(KEY_A)).toMatchObject({ initial: 4, growthLimit: 8, cap: 4 });
    const live = await climb(governor, "A", tickets, 80);
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    for (const t of live) outcome.completed(t);
  });

  it("用过这个 key 的在飞 run 登记了高于 2D 的上界 → 增长上限抬到它；没用过这个 key 的 run 不抬", async () => {
    const { governor, admitNow } = makeGovernor(4);
    governor.setRunBound("big", 20);
    governor.setRunBound("elsewhere", 50);
    admitNow("elsewhere", KEY_B);
    const tickets = Array.from({ length: 4 }, () => admitNow("big"));
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(20);
    expect(governor.snapshot(KEY_B)?.growthLimit).toBe(50);
    // Jump start: the first admission pulls cap straight to the registered ceiling — no climbing one step at a time.
    expect(governor.snapshot(KEY_A)?.cap).toBe(20);
    expect(governor.snapshot(KEY_B)?.cap).toBe(50);
    for (const t of tickets) outcome.completed(t);
  });

  it("上界不高于 2D 的 run 不抬增长上限；observer 永不抬", async () => {
    const { governor, admitNow, observe } = makeGovernor(4);
    governor.setRunBound("small", 3);
    admitNow("small");
    outcome.completed(await observe());
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
  });

  it("run 清掉上界：增长上限落回、高于新上限的 cap 被拉下来，limit_lowered 扇给仍 engaged 的 run", async () => {
    const { governor, admitNow } = makeGovernor(4);
    const seenOther: ConcurrencyChange[] = [];
    governor.subscribe("other", (change) => seenOther.push(change));
    governor.setRunBound("big", 20);
    // Another default run keeps one in-flight request on this key (engaged, so it receives the fan-out).
    const other = admitNow("other");
    const live = Array.from({ length: 3 }, () => admitNow("big"));
    const capBefore = governor.snapshot(KEY_A)!.cap;
    expect(capBefore).toBeGreaterThan(8);
    governor.clearRunBound("big");
    expect(governor.snapshot(KEY_A)).toMatchObject({ growthLimit: 8, cap: 8 });
    expect(seenOther.at(-1)).toMatchObject({
      key: KEY_A,
      previous: capBefore,
      next: 8,
      reason: "limit_lowered",
    });
    for (const t of live) outcome.completed(t);
    outcome.completed(other);
  });

  it("retune 调低上界同样落回；调回高位再抬起来（setRunBound 覆盖旧值）", async () => {
    const { governor, admitNow } = makeGovernor(4);
    governor.setRunBound("r", 30);
    const ticket = admitNow("r");
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(30);
    governor.setRunBound("r", 5);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
    governor.setRunBound("r", 12);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(12);
    outcome.completed(ticket);
  });

  it("run 先用 key、后登记上界：登记即抬起它用过的 key", () => {
    const { governor, admitNow } = makeGovernor(4);
    const ticket = admitNow("late");
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
    governor.setRunBound("late", 16);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(16);
    outcome.completed(ticket);
  });
});

describe("workflow concurrency governor — 调高上界即起跳（docs/dynamic-workflow/concurrency.md「Seeding」）", () => {
  it("retune 调高：cap 当场跳到新上界，seeded 扇给这个 run——哪怕它此刻没有在飞请求", () => {
    const { governor, admitNow } = makeGovernor(8);
    const seen: ConcurrencyChange[] = [];
    governor.subscribe("r", (change) => seen.push(change));
    governor.setRunBound("r", 8);
    outcome.completed(admitNow("r")); // has used this key, currently idle
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    governor.setRunBound("r", 32);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 32, growthLimit: 32 });
    expect(seen.at(-1)).toMatchObject({ key: KEY_A, previous: 8, next: 32, reason: "seeded" });
  });

  it("五分钟内有过 429 就不起跳：cap 照常靠探测爬", async () => {
    const { governor, admitNow, observe } = makeGovernor(8);
    governor.setRunBound("r", 8);
    const ticket = admitNow("r");
    outcome.throttled429(await observe()); // 8 → 6
    governor.setRunBound("r", 32);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, growthLimit: 32 });
    outcome.completed(ticket);
  });

  it("默认上界与压低的上界都不起跳", () => {
    const { governor, admitNow } = makeGovernor(8);
    governor.setRunBound("a", 8);
    governor.setRunBound("b", 3);
    const tickets = [admitNow("a"), admitNow("b")];
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    for (const t of tickets) outcome.completed(t);
  });

  it("起跳之后撞墙：第一次 429 按系数减（32 → 24），同一波的其余 429 不再减", async () => {
    const { governor, admitNow } = makeGovernor(8);
    governor.setRunBound("r", 32);
    const tickets = Array.from({ length: 32 }, () => admitNow("r"));
    expect(governor.snapshot(KEY_A)?.cap).toBe(32);
    for (const t of tickets.slice(0, 20)) outcome.throttled429(t);
    expect(governor.snapshot(KEY_A)?.cap).toBe(24);
    for (const t of tickets.slice(20)) outcome.completed(t);
  });
});
