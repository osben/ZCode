/**
 * Run-level seat gate (docs/dynamic-workflow/concurrency.md "Retuning a live run"):
 *   - after a decrease, working subagents park at their **next turn step** (tryAcquire misses → the runner emits
 *     queued → the driver reports waiting(slot)); acquire first waits for a seat, then goes through the governor;
 *   - ask settlement or a raised bound admits in FIFO order; abort dequeues and rejects with signal.reason;
 *   - tool-side requests never park (distinguished by the subagent's in-flight tool count at that moment);
 *   - `activeAsks = working + parked`; a bound of 1 still does not deadlock;
 *   - a run never decreased is pure pass-through: tryAcquire hits each time, and the governor port gets exactly the
 *     calls it would without the gate.
 * Pure unit: no driver is built, no engine runs; the gate is fed just those two facts.
 */

import { describe, expect, it } from "vitest";
import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import type { InstanceRef } from "@zcode/dynamic-workflow";
import {
  createWorkflowRunSeatGate,
  type SeatGateSubagent,
  type WorkflowRunSeatGate,
} from "../src/app/workflow-seat-gate.js";

const MODEL = { providerId: "prov", modelId: "alpha" } as ModelRequestTarget;

/** A stand-in for the governor port: counts calls only and always issues a ticket. */
function fakeGovernor(): {
  admission: ModelRequestAdmission;
  tryAcquireCalls: number;
  acquireCalls: number;
} {
  const ticket = { release: () => {} } as unknown as ModelRequestAdmissionTicket;
  const state = {
    tryAcquireCalls: 0,
    acquireCalls: 0,
    admission: {
      tryAcquire: () => {
        state.tryAcquireCalls++;
        return ticket;
      },
      acquire: async () => {
        state.acquireCalls++;
        return ticket;
      },
    } satisfies ModelRequestAdmission,
  };
  return state;
}

/** A stand-in for a subagent: the in-flight tool count is settable by hand (0 = its next request is a turn step). */
function fakeSubagent(toolsInFlight = 0): SeatGateSubagent & { tools: number } {
  const subagent = {
    tools: toolsInFlight,
    toolsInFlight: () => subagent.tools,
  };
  return subagent;
}

const instanceOf = (ordinal: number): InstanceRef => ({ siteId: "ask#1", ordinal });

/** Admission resolves a promise: let its then chain finish (acquire itself is async too, more than one hop). */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Registers n subagents as "working" and wraps an admission port for each. */
function seatWorkers(gate: WorkflowRunSeatGate, count: number) {
  return Array.from({ length: count }, (_unused, index) => {
    const key = `actor#1@${index + 1}`;
    const instance = instanceOf(index + 1);
    const governor = fakeGovernor();
    const subagent = fakeSubagent();
    gate.askStarted(key, instance);
    return {
      key,
      instance,
      governor,
      subagent,
      admission: gate.wrap(key, subagent, governor.admission)!,
    };
  });
}

describe("workflow seat gate", () => {
  it("从未被压低过的 run 是纯直通：tryAcquire 逐次命中，治理器照常收到每一次调用", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    for (const worker of workers) {
      expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
      await worker.admission.acquire({ model: MODEL });
    }
    expect(gate.stats()).toEqual({ limit: 4, working: 4, parked: 0 });
    for (const worker of workers) {
      expect(worker.governor.tryAcquireCalls).toBe(1);
      expect(worker.governor.acquireCalls).toBe(1);
    }
  });

  it("没有治理器端口时闸门也不凭空造一个（两条闸门要么一起在、要么一起不在）", () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    expect(gate.wrap("actor#1@1", fakeSubagent(), undefined)).toBeUndefined();
  });

  it("压低 4→1：三个在下一个 turn step 上停驻，一个始终在跑，activeAsks = working + parked", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    gate.setLimit(1);

    const parked: Promise<unknown>[] = [];
    for (const worker of workers) {
      // A fast-path miss is exactly the runner's condition for emitting `model_request_queued` → the driver reports
      // waiting(slot).
      if (gate.stats().working > 1) {
        expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
        parked.push(worker.admission.acquire({ model: MODEL }));
      } else {
        expect(worker.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
      }
    }

    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
    // No parker has touched the governor yet: seat first, governor second.
    expect(workers.slice(0, 3).every((worker) => worker.governor.acquireCalls === 0)).toBe(true);
    // activeAsks (the scheduler side) = 4 = working + parked, so the scheduler cannot dispatch any new ask right now.
    expect(gate.stats().working + gate.stats().parked).toBe(4);
    expect(parked.length).toBe(3);
  });

  it("上界 1、5 个在工作：恰好 4 个停驻，总有一个在跑（任何上界都不死锁）", () => {
    const gate = createWorkflowRunSeatGate({ limit: 5 });
    const workers = seatWorkers(gate, 5);
    gate.setLimit(1);
    const missed: string[] = [];
    for (const worker of workers) {
      if (worker.admission.tryAcquire?.({ model: MODEL }) === undefined) {
        missed.push(worker.key);
        void worker.admission.acquire({ model: MODEL });
      }
    }
    expect(missed).toEqual(workers.slice(0, 4).map((worker) => worker.key));
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 4 });
  });

  it("ask 结算按 FIFO 放行队首，并且只放一位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 2)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key, workers[1]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 0 });
  });

  it("抬高上界按 FIFO 放行到新上界为止；两次抬高各放一批", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 4 });
    const workers = seatWorkers(gate, 4);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 3)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });

    gate.setLimit(2);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);

    gate.setLimit(4);
    await flush();
    expect(granted).toEqual([workers[0]!.key, workers[1]!.key, workers[2]!.key]);
    expect(gate.stats()).toEqual({ limit: 4, working: 4, parked: 0 });
  });

  it("停驻期间 abort：出队、以 signal.reason 拒绝，并**回到 working**（不在 parked 即在工作）", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const controller = new AbortController();
    const reason = new Error("workflow ask cancelled");
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    // Back to working: momentarily exceeding the bound is a legal transient; the next one to raise a turn request
    // parks as usual.
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });
  });

  // What is aborted is **this request**, not necessarily the ask (the driver's transient re-drives and stream
  // recoveries both look like this). The ask is still alive, so every later turn step of it must still pass the seat —
  // otherwise it is never counted again and the bound quietly drifts upward.
  it("只是请求被 abort、ask 还活着：下一个 turn step 照旧受闸门约束并被计数", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const controller = new AbortController();
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL });
    controller.abort(new Error("request aborted"));
    await expect(aborted).rejects.toThrow();
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });

    // The same subagent's next turn request: fast-path miss, then parks, and the count converges back to the bound.
    expect(workers[0]!.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void workers[0]!.admission.acquire({ model: MODEL });
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });
    expect(workers[0]!.governor.acquireCalls).toBe(0);
  });

  it("abort 之后 ask 才真的结算：腾掉它自己那一份，绝不放出一个它从未占过的座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    const controller = new AbortController();
    const aborted = workers[0]!.admission.acquire({ model: MODEL, signal: controller.signal });
    void workers[1]!.admission.acquire({ model: MODEL }).then(() => granted.push(workers[1]!.key));
    controller.abort(new Error("workflow ask cancelled"));
    await expect(aborted).rejects.toThrow();
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await flush();
    // working 2 → 1 = the bound: unpark's `working.size < limit` guard blocked that admission.
    expect(granted).toEqual([]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // Only when the one actually running settles does the queue head get its turn.
    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[1]!.key]);
  });

  it("已经 aborted 的 signal：当场拒绝，不进 FIFO，也从未离开 working", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const reason = new Error("already gone");
    await expect(
      workers[0]!.admission.acquire({ model: MODEL, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 0 });
  });

  it("停驻者的 ask 反序结算（先 node-settled 后 abort）：出队、拒绝等待、不腾座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const waiting = workers[0]!.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    gate.askSettled(workers[0]!.instance);
    await expect(waiting).rejects.toThrow(/concurrency seat/);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 0 });
  });

  it("工具侧请求永不停驻：有工具在跑就直通治理器，工具跑完后的 turn step 才过座位", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const busy = workers[0]!;
    busy.subagent.tools = 2; // two parallel WebSearch calls within one turn

    expect(busy.admission.tryAcquire?.({ model: MODEL })).toBeDefined();
    await busy.admission.acquire({ model: MODEL });
    expect(busy.governor.acquireCalls).toBe(1);
    expect(gate.stats()).toEqual({ limit: 1, working: 3, parked: 0 });

    busy.subagent.tools = 0; // all tools are back; the next request is this ask's next turn step
    expect(busy.admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void busy.admission.acquire({ model: MODEL });
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 1 });
  });

  it("没有在飞 ask 的子代理（会话初始化、压缩）从不停驻", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    seatWorkers(gate, 2);
    gate.setLimit(1);
    const governor = fakeGovernor();
    const outsider = gate.wrap("actor#9@1", fakeSubagent(), governor.admission)!;

    expect(outsider.tryAcquire?.({ model: MODEL })).toBeDefined();
    await outsider.acquire({ model: MODEL });
    expect(governor.acquireCalls).toBe(1);
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 0 });
  });

  it("闸门没见过开始的实例结算是**严格**无操作：不腾座位、不放行", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    const workers = seatWorkers(gate, 2);
    gate.setLimit(1);
    const granted: string[] = [];
    void workers[0]!.admission.acquire({ model: MODEL }).then(() => granted.push(workers[0]!.key));
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // Three kinds of `node-settled` that never went through startAsk: a cache-hit ask (`cached: true`, no
    // queued/dispatched), world-read / world.run nodes (a different set of sites), and the one whose session creation
    // failed so it was never dispatched.
    gate.askSettled({ siteId: "ask#1", ordinal: 99 });
    gate.askSettled({ siteId: "world#3", ordinal: 1 });
    gate.askSettled({ siteId: "run#2", ordinal: 1 });
    await flush();
    expect(granted).toEqual([]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });
  });

  // The scheduler bumps activeAsks at pumpActor, while the gate only counts someone into working at driver.startAsk —
  // in between sits `ensureSession` (create the actor session, persist it, build the task link). When a decrease
  // lands exactly in that window, that subagent's subsequent startAsk pushes working over the bound again, so its
  // first turn step must park.
  it("压低落在 ensureSession 窗口里：后到的子代理照样停驻，没有人被停驻两次，计数收敛到上界", async () => {
    const gate = createWorkflowRunSeatGate({ limit: 3 });
    const workers = seatWorkers(gate, 3);
    gate.setLimit(1);
    const granted: string[] = [];
    for (const worker of workers.slice(0, 2)) {
      void worker.admission.acquire({ model: MODEL }).then(() => granted.push(worker.key));
    }
    await flush();
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    // The fourth subagent only now comes out of ensureSession (its activeAsks was recorded long before the decrease).
    const late = "actor#1@4";
    const lateGovernor = fakeGovernor();
    const lateSubagent = fakeSubagent();
    const lateAdmission = gate.wrap(late, lateSubagent, lateGovernor.admission)!;
    gate.askStarted(late, instanceOf(4));
    expect(gate.stats()).toEqual({ limit: 1, working: 2, parked: 2 });

    expect(lateAdmission.tryAcquire?.({ model: MODEL })).toBeUndefined();
    void lateAdmission.acquire({ model: MODEL }).then(() => granted.push(late));
    await flush();
    // Three are queued, one is running: working converges back to the bound and nobody is counted twice.
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
    expect(lateGovernor.acquireCalls).toBe(0);

    // The running one settles: the queue head is admitted, the queue shrinks by one, working stays at the bound.
    gate.askSettled(workers[2]!.instance);
    await flush();
    expect(granted).toEqual([workers[0]!.key]);
    expect(gate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });
  });

  it("同一个 actor 接连两个 ask：加入是幂等的，不会把一个人数成两个", () => {
    const gate = createWorkflowRunSeatGate({ limit: 2 });
    gate.askStarted("actor#1@1", instanceOf(1));
    gate.askSettled(instanceOf(1));
    gate.askStarted("actor#1@1", instanceOf(2));
    gate.askStarted("actor#1@1", instanceOf(3));
    expect(gate.stats()).toEqual({ limit: 2, working: 1, parked: 0 });
  });
});
