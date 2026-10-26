import { describe, expect, it } from "vitest";
import {
  POLLING_MIN_DURATION_MS,
  toolLoopHistoryLimit,
  buildToolCallRotationReminderBody,
  createToolLoopHistory,
  isPollingToolCall,
  recordToolCallRotation,
  type ToolCallRotationObservation,
  type ToolLoopHistory,
} from "../src/runtime/helpers/tool-loop-patterns.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

describe("isPollingToolCall", () => {
  it("exempts TaskOutput and GetWorkflowRun by name even without a result", () => {
    expect(isPollingToolCall("TaskOutput", { task_id: "t1" }, undefined)).toBe(true);
    expect(isPollingToolCall("GetWorkflowRun", { run_id: "r1" }, result())).toBe(true);
  });

  it("does not exempt a slow call that failed, so a re-run failing build still counts", () => {
    expect(
      isPollingToolCall("Bash", { command: "pnpm test" }, result({ durationMs: 45_000, success: false })),
    ).toBe(false);
  });

  it("exempts any successful call that ran at least POLLING_MIN_DURATION_MS", () => {
    expect(isPollingToolCall("Bash", { command: "sleep 60 && echo done" }, result({ durationMs: POLLING_MIN_DURATION_MS }))).toBe(true);
    expect(
      isPollingToolCall("Bash", { command: "sleep 60 && echo done" }, result({ durationMs: POLLING_MIN_DURATION_MS - 1 })),
    ).toBe(false);
  });

  it("exempts a TaskOutput result that is not ready yet", () => {
    const pending = result({ toolName: "TaskOutput", output: { retrieval_status: "not_ready", task: null } });
    const timedOut = result({ toolName: "TaskOutput", output: { retrieval_status: "timeout", task: null } });
    expect(isPollingToolCall("TaskOutput", { task_id: "t1" }, pending)).toBe(true);
    expect(isPollingToolCall("TaskOutput", { task_id: "t1" }, timedOut)).toBe(true);
    expect(
      isPollingToolCall("Other", { task_id: "t1" }, result({ output: { retrieval_status: "timeout" } })),
    ).toBe(false);
  });

  it("exempts successful tail-only log watch commands", () => {
    const commands = [
      "tail -n 50 build.log",
      "tail -50 build.log",
      "tail build.log",
      "tail -n 5 logs/app.log",
      "tail -n 5 a.log; tail -n 5 b.log",
      "tail -n 5 a.log && tail -n 5 b.log",
      "Get-Content -Tail 50 app.log",
      "get-content -tail 20 logs\\app.LOG",
      'tail -n 5 "my build.log"',
      " tail -n 50 build.log ",
    ];
    for (const command of commands) {
      expect(isPollingToolCall("Bash", { command }, result())).toBe(true);
    }
  });

  it("does not exempt failed tails, other commands, or non-literal paths", () => {
    const commands = [
      "cat build.log",
      "tail -n 50 src/index.ts",
      "tail -n 5 build.log | grep error",
      "tail -n 5 $(ls *.log)",
      "tail -n 5 build.log > out.txt",
      "tail -n 5 build.log; cat b.log",
      "tail -n 5 $LOGFILE",
      "tail",
      "",
    ];
    for (const command of commands) {
      expect(isPollingToolCall("Bash", { command }, result())).toBe(false);
    }
    expect(isPollingToolCall("Bash", { command: "tail -n 50 build.log" }, result({ success: false }))).toBe(false);
    expect(isPollingToolCall("Bash", { command: 42 }, result())).toBe(false);
  });

  it("treats calls without a result as normal calls", () => {
    expect(isPollingToolCall("Bash", { command: "tail -n 50 build.log" }, undefined)).toBe(false);
  });
});

describe("recordToolCallRotation", () => {
  it("fires once at the third cycle of a two-tool rotation", () => {
    const history = createToolLoopHistory();
    const budget = { anomalyWarningsInjected: 0 };
    const observations = play(history, budget, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("pong-2", "Pong", { file: "b" }, 2),
      call("ping-3", "Ping", { file: "a" }, 3),
      call("pong-4", "Pong", { file: "b" }, 4),
      call("ping-5", "Ping", { file: "a" }, 5),
      call("pong-6", "Pong", { file: "b" }, 6),
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      cycles: 3,
      period: 2,
      threshold: 3,
      toolCallId: "pong-6",
      toolName: "Pong",
      toolNames: ["Ping", "Pong"],
      warningInjected: true,
    });
    expect(budget.anomalyWarningsInjected).toBe(1);
  });

  it("fires at the ninth call of a three-tool rotation", () => {
    const history = createToolLoopHistory();
    const calls = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      calls.push(call(`ping-${cycle * 3 + 1}`, "Ping", { file: "a" }, cycle * 3 + 1));
      calls.push(call(`pong-${cycle * 3 + 2}`, "Pong", { file: "b" }, cycle * 3 + 2));
      calls.push(call(`mark-${cycle * 3 + 3}`, "Mark", { file: "c" }, cycle * 3 + 3));
    }
    const observations = play(createToolLoopHistory(), { anomalyWarningsInjected: 0 }, undefined, calls);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      cycles: 3,
      period: 3,
      toolCallId: `mark-${3 * 3}`,
      toolNames: ["Ping", "Pong", "Mark"],
    });
  });

  it("does not fire for a rotation inside one model step", () => {
    const calls = [];
    for (let index = 0; index < 6; index += 1) {
      const name = index % 2 === 0 ? "Ping" : "Pong";
      calls.push(call(`call-${index + 1}`, name, { file: name === "Ping" ? "a" : "b" }, 1));
    }
    expect(play(createToolLoopHistory(), { anomalyWarningsInjected: 0 }, undefined, calls)).toHaveLength(0);
  });

  it("fires when the cycle spans two model steps even if partially batched", () => {
    const history = createToolLoopHistory();
    const observations = play(history, { anomalyWarningsInjected: 0 }, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("pong-2", "Pong", { file: "b" }, 1),
      call("ping-3", "Ping", { file: "a" }, 1),
      call("pong-4", "Pong", { file: "b" }, 1),
      call("ping-5", "Ping", { file: "a" }, 2),
      call("pong-6", "Pong", { file: "b" }, 2),
    ]);

    expect(observations).toHaveLength(1);
  });

  it("does not fire before the window fills or when signatures are not distinct", () => {
    const budget = { anomalyWarningsInjected: 0 };
    const shortWindow = play(createToolLoopHistory(), budget, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("pong-2", "Pong", { file: "b" }, 2),
      call("ping-3", "Ping", { file: "a" }, 3),
      call("pong-4", "Pong", { file: "b" }, 4),
      call("ping-5", "Ping", { file: "a" }, 5),
    ]);
    expect(shortWindow).toHaveLength(0);

    const sameSignature = play(createToolLoopHistory(), budget, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("ping-2", "Ping", { file: "a" }, 2),
      call("ping-3", "Ping", { file: "a" }, 3),
      call("ping-4", "Ping", { file: "a" }, 4),
      call("ping-5", "Ping", { file: "a" }, 5),
      call("ping-6", "Ping", { file: "a" }, 6),
    ]);
    expect(sameSignature).toHaveLength(0);
  });

  it("fires again only after the cycle breaks and rebuilds", () => {
    const history = createToolLoopHistory();
    const budget = { anomalyWarningsInjected: 0 };
    const first = play(history, budget, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("pong-2", "Pong", { file: "b" }, 2),
      call("ping-3", "Ping", { file: "a" }, 3),
      call("pong-4", "Pong", { file: "b" }, 4),
      call("ping-5", "Ping", { file: "a" }, 5),
      call("pong-6", "Pong", { file: "b" }, 6),
    ]);
    expect(first).toHaveLength(1);

    // The cycle keeps matching while disarmed: no re-fire.
    const continuing = play(history, budget, undefined, [
      call("ping-7", "Ping", { file: "a" }, 7),
      call("pong-8", "Pong", { file: "b" }, 8),
    ]);
    expect(continuing).toHaveLength(0);

    // A foreign call breaks the cycle and re-arms the latch.
    const breaking = play(history, budget, undefined, [call("mark-9", "Mark", { file: "c" }, 9)]);
    expect(breaking).toHaveLength(0);

    const second = play(history, budget, undefined, [
      call("edit-10", "Edit", { path: "x" }, 10),
      call("read-11", "Read", { path: "y" }, 11),
      call("edit-12", "Edit", { path: "x" }, 12),
      call("read-13", "Read", { path: "y" }, 13),
      call("edit-14", "Edit", { path: "x" }, 14),
      call("read-15", "Read", { path: "y" }, 15),
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ period: 2, toolCallId: "read-15" });
  });

  it("returns no observation and keeps history empty when disabled", () => {
    const history = createToolLoopHistory();
    const observation = recordToolCallRotation(
      history,
      call("ping-1", "Ping", { file: "a" }, 1),
      { anomalyWarningsInjected: 0 },
      { repeatedToolCallWarningThreshold: 0 },
    );

    expect(observation).toBeUndefined();
    expect(history.entries).toHaveLength(0);
  });

  it("reports warningInjected=false once the budget is exhausted", () => {
    const history = createToolLoopHistory();
    const budget = { anomalyWarningsInjected: 3 };
    const observations = play(history, budget, undefined, rotationCalls());

    expect(observations).toHaveLength(1);
    expect(observations[0]?.warningInjected).toBe(false);
    expect(budget.anomalyWarningsInjected).toBe(3);
  });

  it("caps the kept history at three times the threshold", () => {
    const history = createToolLoopHistory();
    const calls = [];
    const limit = toolLoopHistoryLimit(3);
    for (let index = 0; index < limit + 3; index += 1) {
      calls.push(call(`call-${index}`, "Ping", { file: `f${index}` }, index + 1));
    }
    play(history, { anomalyWarningsInjected: 0 }, undefined, calls);

    expect(limit).toBe(9);
    expect(history.entries).toHaveLength(limit);
    expect(history.entries[0]?.toolCallId).toBe("call-3");
  });

  it("detects a period-3 rotation when the threshold is raised above 3", () => {
    const history = createToolLoopHistory();
    const calls = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const name of ["A", "B", "C"]) {
        calls.push(call(`${name}-${cycle}`, name, { cycle: 0 }, cycle * 3 + 1));
      }
    }
    const observations = play(
      history,
      { anomalyWarningsInjected: 0 },
      { repeatedToolCallWarningThreshold: 4 },
      calls,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.period).toBe(3);
    expect(observations[0]?.toolCallId).toBe("C-3");
  });

  it("collapses repeated tool names in the rotation observation", () => {
    const history = createToolLoopHistory();
    const observations = play(history, { anomalyWarningsInjected: 0 }, undefined, [
      call("ping-1", "Ping", { file: "a" }, 1),
      call("ping-2", "Ping", { file: "b" }, 2),
      call("ping-3", "Ping", { file: "a" }, 3),
      call("ping-4", "Ping", { file: "b" }, 4),
      call("ping-5", "Ping", { file: "a" }, 5),
      call("ping-6", "Ping", { file: "b" }, 6),
    ]);

    expect(observations[0]?.toolNames).toEqual(["Ping"]);
  });
});

describe("buildToolCallRotationReminderBody", () => {
  it("mentions only tool names, period, and cycles", () => {
    const body = buildToolCallRotationReminderBody(["Ping", "Pong"], 2, 3);
    expect(body).toContain("You have been cycling between Ping, Pong (period 2) 3 times without progress.");
    expect(body).not.toContain("file");
  });
});

function rotationCalls() {
  const calls = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    calls.push(call(`ping-${cycle * 2 + 1}`, "Ping", { file: "a" }, cycle * 2 + 1));
    calls.push(call(`pong-${cycle * 2 + 2}`, "Pong", { file: "b" }, cycle * 2 + 2));
  }
  return calls;
}

function play(
  history: ToolLoopHistory,
  budget: { anomalyWarningsInjected: number },
  config: Parameters<typeof recordToolCallRotation>[3],
  calls: Array<{ id: string; name: string; input: unknown; modelStepIndex: number }>,
): ToolCallRotationObservation[] {
  const observations: ToolCallRotationObservation[] = [];
  for (const entry of calls) {
    const observation = recordToolCallRotation(history, entry, budget, config);
    if (observation) observations.push(observation);
  }
  return observations;
}

function call(id: string, name: string, input: unknown, modelStepIndex: number) {
  return { id, name, input, modelStepIndex };
}

function result(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    toolCallId: "call-1",
    toolName: "Bash",
    success: true,
    output: "ok",
    durationMs: 100,
    startedAt: new Date(0),
    completedAt: new Date(100),
    ...overrides,
  };
}
