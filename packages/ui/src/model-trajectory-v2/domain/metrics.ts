import type { ZCodeModelTrajectoryV2, ZCodeTrajectoryV2Record } from "../contract.js";
import { recordEndMs, recordStartMs } from "./ledger.js";

export interface Interval {
  start: number;
  end: number;
}

/** Total length of the union of intervals (overlaps counted once). */
export function unionLength(intervals: readonly Interval[]): number {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursorStart = Number.NEGATIVE_INFINITY;
  let cursorEnd = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    if (item.start > cursorEnd) {
      if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
      cursorStart = item.start;
      cursorEnd = item.end;
    } else {
      cursorEnd = Math.max(cursorEnd, item.end);
    }
  }
  if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
  return total;
}

function isMain(record: ZCodeTrajectoryV2Record): boolean {
  return (record.callSource?.kind ?? "main") === "main";
}

export function contextWindowFor(
  record: ZCodeTrajectoryV2Record,
  windows: ZCodeModelTrajectoryV2["contextWindows"],
): number | undefined {
  return windows.find(
    (item) => item.providerId === record.model.providerId && item.modelId === record.model.modelId,
  )?.tokens;
}

export interface TrajectorySummary {
  mainCalls: number;
  otherCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Σ cacheRead / Σ input over main calls with usage; undefined without usage. */
  cacheHitRatio?: number;
  /** Max inputTokens / window over main calls; undefined when no window is known. */
  peakContextRatio?: number;
  modelBusyMs: number;
  modelSumMs: number;
  /** Undefined when tool timing is unavailable. */
  toolBusyMs?: number;
  toolSumMs?: number;
}

export function summarizeTrajectory(trajectory: ZCodeModelTrajectoryV2): TrajectorySummary {
  let mainCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let mainInput = 0;
  let mainCacheRead = 0;
  let peak: number | undefined;
  const modelIntervals: Interval[] = [];
  for (const record of trajectory.records) {
    const usage = record.response?.usage;
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    reasoningTokens += usage?.reasoningTokens ?? 0;
    modelIntervals.push({ start: recordStartMs(record), end: recordEndMs(record) });
    if (!isMain(record)) continue;
    mainCalls += 1;
    if (usage?.inputTokens !== undefined) {
      mainInput += usage.inputTokens;
      mainCacheRead += usage.cacheReadTokens ?? 0;
      const window = contextWindowFor(record, trajectory.contextWindows);
      if (window) peak = Math.max(peak ?? 0, usage.inputTokens / window);
    }
  }
  const toolIntervals = toolExecIntervals(trajectory);
  const timingKnown = trajectory.toolTiming.source === "session-db";
  return {
    mainCalls,
    otherCalls: trajectory.records.length - mainCalls,
    inputTokens,
    outputTokens,
    reasoningTokens,
    ...(mainInput > 0 ? { cacheHitRatio: mainCacheRead / mainInput } : {}),
    ...(peak !== undefined ? { peakContextRatio: peak } : {}),
    modelBusyMs: unionLength(modelIntervals),
    modelSumMs: modelIntervals.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0),
    ...(timingKnown
      ? {
          toolBusyMs: unionLength(toolIntervals),
          toolSumMs: toolIntervals.reduce((sum, item) => sum + (item.end - item.start), 0),
        }
      : {}),
  };
}

function toolExecIntervals(trajectory: ZCodeModelTrajectoryV2): Interval[] {
  return trajectory.toolTiming.entries.flatMap((entry) =>
    entry.execStartedAt !== undefined && entry.execEndedAt !== undefined
      ? [{ start: entry.execStartedAt, end: entry.execEndedAt }]
      : [],
  );
}

export interface ToolTimeRow {
  name: string;
  totalMs: number;
  calls: number;
}

/** Plain execution-time sums per tool name, longest first. */
export function toolTimeByName(trajectory: ZCodeModelTrajectoryV2): ToolTimeRow[] {
  const byName = new Map<string, ToolTimeRow>();
  for (const entry of trajectory.toolTiming.entries) {
    const row = byName.get(entry.toolName) ?? { name: entry.toolName, totalMs: 0, calls: 0 };
    row.calls += 1;
    row.totalMs += entry.execDurationMs ?? 0;
    byName.set(entry.toolName, row);
  }
  return [...byName.values()].sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));
}

export interface ContextPoint {
  recordIndex: number;
  t: number;
  inputTokens: number;
  outputTokens: number;
  window?: number;
  ratio?: number;
  /** A compact call happened before this point, or this call's input was rewritten. */
  marker?: "compact" | "context-reset";
}

/** One point per main call with usage; compaction and context rewrites mark the next point. */
export function contextSeries(trajectory: ZCodeModelTrajectoryV2): ContextPoint[] {
  const points: ContextPoint[] = [];
  let pendingCompact = false;
  let seenMain = false;
  trajectory.records.forEach((record, recordIndex) => {
    const kind = record.callSource?.kind ?? "main";
    if (kind === "compact") {
      pendingCompact = true;
      return;
    }
    if (kind !== "main") return;
    const reset = seenMain && !record.inputDeltaOf;
    seenMain = true;
    const usage = record.response?.usage;
    if (usage?.inputTokens === undefined) return;
    const window = contextWindowFor(record, trajectory.contextWindows);
    const marker = pendingCompact ? "compact" : reset ? "context-reset" : undefined;
    pendingCompact = false;
    points.push({
      recordIndex,
      t: recordStartMs(record),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens ?? 0,
      ...(window ? { window, ratio: usage.inputTokens / window } : {}),
      ...(marker ? { marker } : {}),
    });
  });
  return points;
}
