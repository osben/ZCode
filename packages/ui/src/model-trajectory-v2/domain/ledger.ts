import type {
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryV2,
  ZCodeTrajectoryV2Record,
  ZCodeTrajectoryV2ToolTiming,
} from "../contract.js";

export type LedgerMarker = "compact" | "context-reset" | "window-truncated" | "retry";

interface RowBase {
  key: string;
  /** Epoch ms; NaN-free (records without a start time use 0). */
  t0: number;
  /** Epoch ms end; equal to t0 for instants. */
  t1: number;
}

export type LedgerRow =
  | (RowBase & { kind: "turn"; turnId: string })
  | (RowBase & {
      kind: "request";
      recordIndex: number;
      source: ZCodeModelTrajectoryCallSourceKind;
    })
  | (RowBase & { kind: "user"; recordIndex: number; messageIndex: number; text: string })
  | (RowBase & {
      kind: "assistant";
      recordIndex: number;
      text?: string;
      reasoning?: string;
      toolCallCount: number;
      finishReason?: string;
      error?: string;
    })
  | (RowBase & {
      kind: "tool";
      recordIndex: number;
      toolCallId: string;
      toolName: string;
      input: unknown;
      result?: { output: unknown; isError: boolean };
      timing?: ZCodeTrajectoryV2ToolTiming;
    })
  | (RowBase & { kind: "marker"; marker: LedgerMarker; recordIndex?: number });

export type LedgerRowKind = LedgerRow["kind"];

export interface LedgerOptions {
  /** Show sidecar and subagent calls as their own request groups (hidden by default). */
  showSidecars?: boolean;
}

export function recordStartMs(record: ZCodeTrajectoryV2Record): number {
  const time = Date.parse(record.startedAt);
  return Number.isNaN(time) ? 0 : time;
}

export function recordEndMs(record: ZCodeTrajectoryV2Record): number {
  const start = recordStartMs(record);
  const completed = record.completedAt ? Date.parse(record.completedAt) : Number.NaN;
  if (!Number.isNaN(completed)) return Math.max(start, completed);
  return start + Math.max(0, record.durationMs ?? 0);
}

function sourceKind(record: ZCodeTrajectoryV2Record): ZCodeModelTrajectoryCallSourceKind {
  return record.callSource?.kind ?? "main";
}

function partText(parts: readonly ZCodeModelTrajectoryContentPart[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.text : part.kind === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Tool results by call id across every record's input (deltas carry each result once). */
function collectToolResults(records: readonly ZCodeTrajectoryV2Record[]) {
  const results = new Map<string, { output: unknown; isError: boolean }>();
  for (const record of records) {
    for (const message of record.request.messages) {
      for (const part of message.parts) {
        if (part.kind !== "tool-result" || !part.toolCallId || results.has(part.toolCallId))
          continue;
        const output = part.output;
        const isError =
          typeof output === "object" &&
          output !== null &&
          (output as { type?: unknown }).type === "error-text";
        results.set(part.toolCallId, { output, isError });
      }
    }
  }
  return results;
}

/** User messages after the last assistant message: the new turn input of a full (non-delta) record. */
function trailingUserMessages(record: ZCodeTrajectoryV2Record) {
  const messages = record.request.messages;
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === "assistant") start = index + 1;
  });
  return messages.map((message, index) => ({ message, index })).slice(start);
}

/**
 * Derive ledger rows from the v2 response (specs/model-trajectory-v2.md, "Ledger"). Pure; keys come from request ids,
 * tool call ids and message indexes so they stay stable when records are appended.
 */
export function buildLedgerRows(
  trajectory: Pick<ZCodeModelTrajectoryV2, "records" | "truncated" | "toolTiming">,
  options: LedgerOptions = {},
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const results = collectToolResults(trajectory.records);
  const timings = new Map(trajectory.toolTiming.entries.map((entry) => [entry.toolCallId, entry]));
  let lastTurnId: string | undefined;
  let seenMain = false;

  const firstStart = trajectory.records[0] ? recordStartMs(trajectory.records[0]) : 0;
  if (trajectory.truncated) {
    rows.push({
      kind: "marker",
      marker: "window-truncated",
      key: "marker:window",
      t0: firstStart,
      t1: firstStart,
    });
  }

  trajectory.records.forEach((record, recordIndex) => {
    const kind = sourceKind(record);
    const t0 = recordStartMs(record);
    const t1 = recordEndMs(record);
    const id = `${record.requestId}:${recordIndex}`;

    if (kind === "compact") {
      rows.push({
        kind: "marker",
        marker: "compact",
        key: `marker:compact:${id}`,
        recordIndex,
        t0,
        t1,
      });
      return;
    }
    if (kind !== "main" && !options.showSidecars) return;

    if (kind === "main" && record.turnId && record.turnId !== lastTurnId) {
      lastTurnId = record.turnId;
      rows.push({ kind: "turn", turnId: record.turnId, key: `turn:${record.turnId}`, t0, t1: t0 });
    }
    if (record.attempt > 1) {
      rows.push({
        kind: "marker",
        marker: "retry",
        key: `marker:retry:${id}`,
        recordIndex,
        t0,
        t1: t0,
      });
    }
    rows.push({ kind: "request", source: kind, recordIndex, key: `req:${id}`, t0, t1 });

    if (kind === "main") {
      const isDelta = Boolean(record.inputDeltaOf);
      if (!isDelta && seenMain) {
        rows.push({
          kind: "marker",
          marker: "context-reset",
          key: `marker:reset:${id}`,
          recordIndex,
          t0,
          t1: t0,
        });
      }
      seenMain = true;
      const entries = isDelta
        ? record.request.messages.map((message, index) => ({ message, index }))
        : trailingUserMessages(record);
      for (const { message, index } of entries) {
        if (message.role !== "user") continue;
        const text = partText(message.parts);
        if (!text) continue;
        rows.push({
          kind: "user",
          recordIndex,
          messageIndex: index,
          text,
          key: `user:${id}:${index}`,
          t0,
          t1: t0,
        });
      }
    }

    const response = record.response;
    if (response || record.error) {
      rows.push({
        kind: "assistant",
        recordIndex,
        key: `asst:${id}`,
        t0,
        t1,
        ...(response?.text ? { text: response.text } : {}),
        toolCallCount: (response?.toolCalls ?? []).filter((part) => part.kind === "tool-call")
          .length,
        ...(response?.reasoningText ? { reasoning: response.reasoningText } : {}),
        ...(response?.finishReason ? { finishReason: response.finishReason } : {}),
        ...(record.error ? { error: record.error.message || record.error.name } : {}),
      });
    }

    for (const part of response?.toolCalls ?? []) {
      if (part.kind !== "tool-call") continue;
      const toolCallId = part.toolCallId ?? `${id}:${part.toolName}`;
      const timing = part.toolCallId ? timings.get(part.toolCallId) : undefined;
      const start = timing?.execStartedAt ?? timing?.scheduledAt ?? t1;
      const result = part.toolCallId ? results.get(part.toolCallId) : undefined;
      rows.push({
        kind: "tool",
        recordIndex,
        toolCallId,
        toolName: part.toolName,
        input: part.input,
        key: `tool:${toolCallId}`,
        t0: start,
        t1: timing?.execEndedAt ?? start,
        ...(result ? { result } : {}),
        ...(timing ? { timing } : {}),
      });
    }
  });
  return rows;
}

/** Rows whose interval intersects [from, to] (inclusive). Turn headers are kept when any of their rows are. */
export function filterRowsByRange(
  rows: readonly LedgerRow[],
  range: { from: number; to: number } | null,
) {
  if (!range) return [...rows];
  const kept: LedgerRow[] = [];
  let pendingTurn: LedgerRow | undefined;
  for (const row of rows) {
    if (row.kind === "turn") {
      pendingTurn = row;
      continue;
    }
    if (row.t1 < range.from || row.t0 > range.to) continue;
    if (pendingTurn) {
      kept.push(pendingTurn);
      pendingTurn = undefined;
    }
    kept.push(row);
  }
  return kept;
}
