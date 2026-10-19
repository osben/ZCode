// The adaptive concurrency observation surface of the dwf run detail page (docs/dynamic-workflow/concurrency.md
// "Protocol and UI"):
// the run head's concurrency/cooldown reading, the event log's three kinds of lines, and the phase → four graph values
// mapping.
// All jsdom-free: these are pure rules with the clock injected as a parameter.
import { describe, expect, it } from "vitest";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { workflowRunEventLines } from "@/app-shell/workflowRunPanel.js";
import {
  throttleReasonLabel,
  workflowRunConcurrencyChip,
  workflowRunConcurrencyView,
} from "@/app-shell/workflowRunThrottle.js";
import { statusOfRunNode } from "@/components/workflow-graph/run-status.js";

const format = (descriptor: { id: string }, values?: Record<string, string>) =>
  values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id;

const T0 = 1_700_000_000_000;

function node(overrides: Partial<WorkflowRunNode> = {}): WorkflowRunNode {
  return {
    siteId: "ask#1",
    ordinal: 1,
    kind: "ask",
    phase: "executing",
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    ...overrides,
  };
}

describe("原因标签（事件日志用）", () => {
  it("已知原因映射到短标签键，陌生原因原样显示", () => {
    expect(throttleReasonLabel("rate_limited", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.rateLimited",
    );
    expect(throttleReasonLabel("provider_overloaded", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.overloaded",
    );
    expect(throttleReasonLabel("offpeak_queued", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.offpeak",
    );
    for (const reason of [
      "server_error",
      "network_error",
      "timeout",
      "stream_idle_timeout",
      "stale_connection",
    ]) {
      expect(throttleReasonLabel(reason, format)).toBe(
        "chat.toolCall.workflow.run.throttle.reason.transient",
      );
    }
    expect(throttleReasonLabel("something_new", format)).toBe("something_new");
  });
});

describe("workflowRunConcurrencyView：被压在自己的界之下，或有自己的界时在场", () => {
  it("跑在默认上 → undefined；被压下去 → cap/ceiling", () => {
    expect(workflowRunConcurrencyView({ cap: 14, ceiling: 14 }, T0)).toBeUndefined();
    expect(workflowRunConcurrencyView(undefined, T0)).toBeUndefined();
    expect(workflowRunConcurrencyView({ cap: 4, ceiling: 14 }, T0)).toEqual({
      cap: 4,
      ceiling: 14,
    });
  });

  // The smaller of the two bounds (docs/dynamic-workflow/concurrency.md "Two bounds on a run"): the reading says how
  // many subagents this run can really have in flight right now; which bound is in force is not its question to answer.
  it("有 limit 时显示两条界里小的那个", () => {
    expect(workflowRunConcurrencyView({ cap: 8, ceiling: 8, limit: 3 }, T0)).toEqual({
      cap: 3,
      ceiling: 8,
    });
    expect(workflowRunConcurrencyView({ cap: 2, ceiling: 8, limit: 3 }, T0)).toEqual({
      cap: 2,
      ceiling: 8,
    });
    // An absent limit means the shared bucket's bound is the only one — verbatim the same as before.
    expect(workflowRunConcurrencyView({ cap: 8, ceiling: 8 }, T0)).toBeUndefined();
  });

  // `ceiling` is the default concurrency D, not a cap (docs/dynamic-workflow/concurrency.md "What the user sees"):
  // the shared bucket can auto-grow to 2D, and the user can tune a run above D.
  it("默认 run 的共享 cap 长到 D 之上：读数是 min(cap, D) = D，没有可说的", () => {
    expect(workflowRunConcurrencyView({ cap: 12, ceiling: 8 }, T0)).toBeUndefined();
  });

  it("调到默认之上的 run：芯片恒在，读数是 min(cap, limit)", () => {
    expect(workflowRunConcurrencyView({ cap: 9, ceiling: 8, limit: 20 }, T0)).toEqual({
      cap: 9,
      ceiling: 8,
    });
    expect(workflowRunConcurrencyView({ cap: 24, ceiling: 8, limit: 20 }, T0)).toEqual({
      cap: 20,
      ceiling: 8,
    });
  });

  it("冷却按收到时刻推 deadline，过期即缺席", () => {
    const concurrency = { cap: 4, ceiling: 14, cooldownMs: 20_000 };
    expect(workflowRunConcurrencyView(concurrency, T0)).toEqual({
      cap: 4,
      ceiling: 14,
      cooldownUntil: T0 + 20_000,
    });
    expect(workflowRunConcurrencyView(concurrency, T0 + 10_000)?.cooldownUntil).toBe(T0 + 20_000);
    expect(workflowRunConcurrencyView(concurrency, T0 + 20_000)).toEqual({ cap: 4, ceiling: 14 });
  });
});

// Chip present = reading present ∧ the run is configurable (docs/dynamic-workflow/concurrency.md "What the user
// sees").
// The chip states a bound whose control is Configure; when the control goes, the chip goes — on a completed run nothing
// still runs under that bound, a superseded run's bound belongs to its successor, and keeping a number would only be
// read as a stale live reading.
describe("workflowRunConcurrencyChip：与 Configure 同进同退", () => {
  function runWith(overrides: Partial<WorkflowRunState>): WorkflowRunState {
    return {
      runId: "run-a",
      toolCallId: "tool-a",
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
      ...overrides,
    };
  }

  it.each([
    ["running", runWith({ status: "running" })],
    ["pending", runWith({ status: "pending" })],
    ["stopped（可恢复，恢复后仍在这条界下跑）", runWith({ status: "stopped", stopReason: "user" })],
    ["errored（换设置重试的主场景）", runWith({ status: "errored" })],
  ])("%s 的 run 带着芯片", (_case, state) => {
    expect(workflowRunConcurrencyChip(state, T0)).toEqual({ cap: 4, ceiling: 13 });
  });

  it.each([
    ["completed", runWith({ status: "completed" })],
    [
      "superseded",
      runWith({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" }),
    ],
  ])("%s 的 run 没有芯片，即便界仍在天花板之下", (_case, state) => {
    expect(workflowRunConcurrencyChip(state, T0)).toBeUndefined();
  });

  it("run 不在投影里、或跑在天花板上 → 没有芯片", () => {
    expect(workflowRunConcurrencyChip(undefined, T0)).toBeUndefined();
    expect(
      workflowRunConcurrencyChip(runWith({ concurrency: { cap: 13, ceiling: 13 } }), T0),
    ).toBeUndefined();
  });

  // The chip's number is a bound, not a running count: the wording must be the bound's wording, and neither language
  // may read as "how many right now".
  it("两种语言都是「最大并发数 N」/「Max concurrency N」", () => {
    const key = "chat.toolCall.workflow.run.concurrency.label";
    expect((zhCN as Record<string, string>)[key]).toBeTruthy();
    expect((enUS as Record<string, string>)[key]).toBe("Max concurrency {cap}");
  });
});

describe("相位 → 图上四值（决策 39）", () => {
  it("executing / repairing / nudged 是 running", () => {
    for (const phase of ["executing", "repairing", "nudged"] as const) {
      expect(statusOfRunNode(node({ phase }))).toBe("running");
    }
  });

  it("queued / dispatched / waiting 都是 pending：还没有请求在 provider 那里跑", () => {
    for (const phase of ["queued", "dispatched", "waiting"] as const) {
      expect(statusOfRunNode(node({ phase }))).toBe("pending");
    }
  });
});

describe("事件日志：三条自适应并发事件各有一行，其余仍走 unknown 兜底", () => {
  it("node-waiting(slot) / node-waiting(backoff) / node-executing / concurrency-changed", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-waiting",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, cause: "slot" },
        },
        {
          sequence: 2,
          type: "node-waiting",
          payload: {
            instance: { siteId: "ask#1", ordinal: 1 },
            cause: "backoff",
            reason: "rate_limited",
            attempt: 2,
            delayMs: 20_500,
          },
        },
        {
          sequence: 3,
          type: "node-executing",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 4,
          type: "concurrency-changed",
          payload: { key: "p/m", previous: 14, next: 7, reason: "rate_limited" },
        },
        { sequence: 5, type: "compaction", payload: { actor: { siteId: "a", ordinal: 1 } } },
      ],
      format,
    );
    expect(lines[0]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.nodeWaitingSlot",
      detail: "ask#1@1",
      tone: "default",
    });
    expect(lines[1]).toMatchObject({
      label:
        "chat.toolCall.workflow.run.event.nodeWaitingBackoff:chat.toolCall.workflow.run.throttle.reason.rateLimited/21",
      detail: "ask#1@1",
      tone: "default",
    });
    expect(lines[2]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.nodeExecuting",
      detail: "ask#1@1",
    });
    expect(lines[3]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.concurrencyChanged:14/7",
      detail: "p/m",
    });
    expect(lines[4]?.label).toBe("chat.toolCall.workflow.run.event.unknown:compaction");
  });

  // run-caps-changed (docs/dynamic-workflow/concurrency.md): an amendment that only changes max_concurrency takes
  // effect in place, and the engine emits this after updating the caps. It is a separate line from
  // concurrency-changed: that one is the governor squeezing the shared bucket ("concurrency 13 → 9"), this one is the
  // user changing this run's own bound.
  it("run-caps-changed 各有一行；caps 读不动时数字写「?」", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-caps-changed",
          payload: {
            caps: { maxConcurrency: 2 },
            previous: { maxConcurrency: 8 },
            concurrencyCeiling: 8,
          },
        },
        { sequence: 2, type: "run-caps-changed", payload: { caps: "nope", previous: 8 } },
      ],
      format,
    );
    expect(lines[0]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.runCapsChanged:8/2",
      tone: "default",
    });
    expect(lines[0]).not.toHaveProperty("detail");
    expect(lines[1]?.label).toBe("chat.toolCall.workflow.run.event.runCapsChanged:?/?");
  });

  it("node-waiting 缺 cause 时按 slot 处理（没有退避细节可说）", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-waiting",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
      ],
      format,
    );
    expect(lines[0]?.label).toBe("chat.toolCall.workflow.run.event.nodeWaitingSlot");
  });
});
