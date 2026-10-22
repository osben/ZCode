import type {
  ZCodeModelTrajectoryMessage,
  ZCodeTrajectoryV2Record,
  ZCodeTrajectoryV2ToolTiming,
} from "@/model-trajectory-v2/contract.js";
import { buildLedgerRows, filterRowsByRange } from "@/model-trajectory-v2/domain/ledger.js";
import type { LedgerRow } from "@/model-trajectory-v2/domain/ledger.js";
import { describe, expect, it } from "vitest";

const T0 = Date.parse("2026-06-03T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const user = (text: string): ZCodeModelTrajectoryMessage => ({
  role: "user",
  parts: [{ kind: "text", text }],
});
const system = (text: string): ZCodeModelTrajectoryMessage => ({
  role: "system",
  parts: [{ kind: "text", text }],
});
const assistant = (text: string): ZCodeModelTrajectoryMessage => ({
  role: "assistant",
  parts: [{ kind: "text", text }],
});
const toolResult = (toolCallId: string, output: unknown): ZCodeModelTrajectoryMessage => ({
  role: "tool",
  parts: [{ kind: "tool-result", toolCallId, output }],
});

function record(
  requestId: string,
  over: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt: at(0),
    callSource: { kind: "main" },
    model: { modelId: "glm-test", providerId: "zai" },
    request: {
      messages: [],
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: true,
    },
    ...over,
  };
}

const unavailableTiming = {
  source: "unavailable" as const,
  reason: "db-missing" as const,
  entries: [],
};

function timing(
  toolCallId: string,
  over: Partial<ZCodeTrajectoryV2ToolTiming> = {},
): ZCodeTrajectoryV2ToolTiming {
  return { toolCallId, toolName: "Read", status: "completed", scheduledAt: T0, ...over };
}

const kinds = (rows: readonly LedgerRow[]) => rows.map((row) => row.kind);
const keys = (rows: readonly LedgerRow[]) => rows.map((row) => row.key);

describe("buildLedgerRows", () => {
  it("orders rows as turn header, request, new user messages, assistant reply and tool rows", () => {
    const first = record("r1", {
      turnId: "t1",
      request: { ...record("r1").request, messages: [system("S"), user("U1")] },
      response: {
        toolCalls: [
          { kind: "tool-call", toolCallId: "tc1", toolName: "Read", input: { path: "/a" } },
        ],
      },
      completedAt: at(1000),
    });
    const second = record("r2", {
      turnId: "t1",
      inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
      request: { ...record("r2").request, messages: [toolResult("tc1", "file body"), user("U2")] },
      response: { text: "A2", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [first, second],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    expect(kinds(rows)).toEqual([
      "turn",
      "request",
      "user",
      "assistant",
      "tool",
      "request",
      "user",
      "assistant",
    ]);
    expect(rows[2]).toMatchObject({ kind: "user", text: "U1", recordIndex: 0, messageIndex: 1 });
    expect(rows[6]).toMatchObject({ kind: "user", text: "U2", recordIndex: 1, messageIndex: 1 });
    expect(rows[4]).toMatchObject({ kind: "tool", toolName: "Read", toolCallId: "tc1" });
  });

  it("shows only user messages after the last assistant message for a first full main record", () => {
    const first = record("r1", {
      turnId: "t1",
      request: {
        ...record("r1").request,
        messages: [system("S"), user("U1"), assistant("A1"), user("U2")],
      },
      response: { text: "A3", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [first],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    // No context-reset marker: this is the first main call in the window.
    expect(kinds(rows)).toEqual(["turn", "request", "user", "assistant"]);
    expect(rows[2]).toMatchObject({ text: "U2", messageIndex: 3 });
  });

  it("emits a context-reset marker for a later full main record", () => {
    const first = record("r1", {
      turnId: "t1",
      inputDeltaOf: { previousRequestId: "r0", sharedPrefixCount: 1 },
      request: { ...record("r1").request, messages: [user("U1")] },
      response: { text: "A1", toolCalls: [] },
    });
    const second = record("r2", {
      turnId: "t1",
      request: { ...record("r2").request, messages: [assistant("A1"), user("U2")] },
      response: { text: "A2", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [first, second],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    const resetIndex = rows.findIndex(
      (row) => row.kind === "marker" && row.marker === "context-reset",
    );
    expect(resetIndex).toBeGreaterThan(-1);
    expect(rows[resetIndex]).toMatchObject({ recordIndex: 1 });
    expect(resetIndex).toBe(
      rows.findIndex((row) => row.kind === "request" && row.key === "req:r2:1") + 1,
    );
    // The full record still shows its trailing user messages.
    expect(rows.some((row) => row.kind === "user" && row.key === "user:r2:1:1")).toBe(true);
  });

  it("renders compact records as a compact marker only", () => {
    const compact = record("r1", {
      callSource: { kind: "compact" },
      request: { ...record("r1").request, messages: [user("compact summary")] },
      response: { text: "summarized", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [compact],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "marker", marker: "compact", recordIndex: 0 });
  });

  it("hides sidecar and subagent calls by default and shows them with showSidecars", () => {
    const main = record("r1", {
      turnId: "t1",
      request: { ...record("r1").request, messages: [user("U1")] },
      response: { text: "A1", toolCalls: [] },
    });
    const sidecar = record("r2", {
      callSource: { kind: "sidecar" },
      request: { ...record("r2").request, messages: [user("side")] },
      response: { text: "sc", toolCalls: [] },
    });
    const subagent = record("r3", {
      callSource: { kind: "subagent" },
      request: { ...record("r3").request, messages: [user("sub")] },
      response: { text: "sa", toolCalls: [] },
    });

    const hidden = buildLedgerRows({
      records: [main, sidecar, subagent],
      truncated: false,
      toolTiming: unavailableTiming,
    });
    expect(hidden.filter((row) => row.kind === "request")).toHaveLength(1);
    expect(hidden.some((row) => row.key.includes("r2") || row.key.includes("r3"))).toBe(false);

    const shown = buildLedgerRows(
      { records: [main, sidecar, subagent], truncated: false, toolTiming: unavailableTiming },
      { showSidecars: true },
    );
    const requests = shown.filter((row) => row.kind === "request");
    expect(requests.map((row) => row.key)).toEqual(["req:r1:0", "req:r2:1", "req:r3:2"]);
    // Turn headers belong to main calls only.
    expect(shown.filter((row) => row.kind === "turn")).toHaveLength(1);
    expect(requests[1]).toMatchObject({ source: "sidecar" });
    expect(requests[2]).toMatchObject({ source: "subagent" });
  });

  it("marks retried attempts before the request separator", () => {
    const retried = record("r1", {
      attempt: 2,
      request: { ...record("r1").request, messages: [user("U1")] },
      response: { text: "A1", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [retried],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    const retryIndex = rows.findIndex((row) => row.kind === "marker" && row.marker === "retry");
    expect(retryIndex).toBe(rows.findIndex((row) => row.kind === "request") - 1);
  });

  it("starts a truncated window with a window-truncated marker", () => {
    const first = record("r1", {
      request: { ...record("r1").request, messages: [user("U1")] },
      response: { text: "A1", toolCalls: [] },
    });

    const rows = buildLedgerRows({
      records: [first],
      truncated: true,
      toolTiming: unavailableTiming,
    });

    expect(rows[0]).toMatchObject({
      kind: "marker",
      marker: "window-truncated",
      key: "marker:window",
    });
  });

  it("joins tool results by toolCallId from a later record's input and flags error-text output", () => {
    const first = record("r1", {
      turnId: "t1",
      response: {
        toolCalls: [
          { kind: "tool-call", toolCallId: "tc-ok", toolName: "Read", input: { path: "/a" } },
          { kind: "tool-call", toolCallId: "tc-err", toolName: "Bash", input: { command: "ls" } },
          { kind: "tool-call", toolCallId: "tc-miss", toolName: "Grep", input: { pattern: "x" } },
        ],
      },
    });
    const second = record("r2", {
      inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
      request: {
        ...record("r2").request,
        messages: [
          toolResult("tc-ok", "file body"),
          toolResult("tc-err", { type: "error-text", value: "command failed" }),
        ],
      },
    });

    const rows = buildLedgerRows({
      records: [first, second],
      truncated: false,
      toolTiming: unavailableTiming,
    });
    const tools = rows.filter((row) => row.kind === "tool");

    expect(tools.map((row) => row.toolCallId)).toEqual(["tc-ok", "tc-err", "tc-miss"]);
    expect(tools[0]).toMatchObject({ result: { output: "file body", isError: false } });
    expect(tools[1]).toMatchObject({
      result: { output: { type: "error-text", value: "command failed" }, isError: true },
    });
    // No tool-result part anywhere for tc-miss: the result field must be absent, not null.
    expect(tools[2]).not.toHaveProperty("result");
  });

  it("uses tool timing when present and falls back to the parent record end without timing", () => {
    const first = record("r1", {
      turnId: "t1",
      response: {
        toolCalls: [
          { kind: "tool-call", toolCallId: "tc-time", toolName: "Read", input: {} },
          { kind: "tool-call", toolCallId: "tc-notime", toolName: "Read", input: {} },
        ],
      },
      completedAt: at(1000),
    });
    const timingEntry = timing("tc-time", {
      scheduledAt: T0 + 500,
      execStartedAt: T0 + 600,
      execEndedAt: T0 + 900,
    });

    const rows = buildLedgerRows({
      records: [first],
      truncated: false,
      toolTiming: { source: "session-db", entries: [timingEntry] },
    });
    const timed = rows.find((row) => row.kind === "tool" && row.toolCallId === "tc-time");
    const fallback = rows.find((row) => row.kind === "tool" && row.toolCallId === "tc-notime");

    expect(timed).toMatchObject({ t0: T0 + 600, t1: T0 + 900, timing: timingEntry });
    expect(fallback).toMatchObject({ t0: T0 + 1000, t1: T0 + 1000 });
    expect(fallback).not.toHaveProperty("timing");
  });

  it("keeps row keys stable when a record is appended", () => {
    const mk = (id: string) =>
      record(id, {
        turnId: id === "r1" ? "t1" : "t2",
        inputDeltaOf: { previousRequestId: "r0", sharedPrefixCount: 0 },
        request: { ...record(id).request, messages: [user(`U-${id}`)] },
        response: {
          text: `A-${id}`,
          toolCalls: [{ kind: "tool-call", toolCallId: `tc-${id}`, toolName: "Read", input: {} }],
        },
      });
    const base = [mk("r1"), mk("r2")];

    const before = buildLedgerRows({
      records: base,
      truncated: true,
      toolTiming: unavailableTiming,
    });
    const after = buildLedgerRows({
      records: [...base, mk("r3")],
      truncated: true,
      toolTiming: unavailableTiming,
    });

    expect(keys(after).slice(0, before.length)).toEqual(keys(before));
  });

  it("emits an assistant row with the error for a failed record without a response", () => {
    const failed = record("r1", {
      request: { ...record("r1").request, messages: [user("U1")] },
      error: { name: "ProviderError", message: "boom" },
    });

    const rows = buildLedgerRows({
      records: [failed],
      truncated: false,
      toolTiming: unavailableTiming,
    });

    expect(kinds(rows)).toEqual(["request", "user", "assistant"]);
    expect(rows[2]).toMatchObject({ kind: "assistant", error: "boom" });
  });
});

describe("filterRowsByRange", () => {
  // Rows: turn t1 [0,0], request r1 [0,1000], user U1 [0,0], assistant r1 [0,1000],
  // turn t2 [5000,5000], request r2 [5000,6000], user U2 [5000,5000], assistant r2 [5000,6000].
  const main = record("r1", {
    turnId: "t1",
    request: { ...record("r1").request, messages: [user("U1")] },
    response: { text: "A1", toolCalls: [] },
    startedAt: at(0),
    completedAt: at(1000),
  });
  const second = record("r2", {
    turnId: "t2",
    inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
    request: { ...record("r2").request, messages: [user("U2")] },
    response: { text: "A2", toolCalls: [] },
    startedAt: at(5000),
    completedAt: at(6000),
  });
  const rows = buildLedgerRows({
    records: [main, second],
    truncated: false,
    toolTiming: unavailableTiming,
  });

  it("keeps rows whose interval intersects the range, inclusive at both ends", () => {
    // Touching r1 at its end (1000) keeps r1's rows; U1 is a strict miss.
    const touching = filterRowsByRange(rows, { from: T0 + 1000, to: T0 + 4000 });
    expect(keys(touching)).toEqual(["turn:t1", "req:r1:0", "asst:r1:0"]);
    // One millisecond past r1's end drops its rows; the t1 header loses all of its rows.
    const past = filterRowsByRange(rows, { from: T0 + 1001, to: T0 + 4000 });
    expect(past).toEqual([]);
    // Touching r2 at its start (5000) keeps the whole second turn.
    expect(
      filterRowsByRange(rows, { from: T0 + 4000, to: T0 + 5000 }).map((row) => row.key),
    ).toEqual(["turn:t2", "req:r2:1", "user:r2:1:0", "asst:r2:1"]);
  });

  it("returns every row for a null range", () => {
    expect(filterRowsByRange(rows, null)).toEqual(rows);
  });

  it("keeps a turn header only when one of its rows is kept", () => {
    const kept = filterRowsByRange(rows, { from: T0 + 4000, to: T0 + 10_000 });
    expect(kept[0]?.kind).toBe("turn");
    expect(kept[0]).toMatchObject({ turnId: "t2" });
    expect(kept.some((row) => row.kind === "turn" && row.turnId === "t1")).toBe(false);
  });
});
