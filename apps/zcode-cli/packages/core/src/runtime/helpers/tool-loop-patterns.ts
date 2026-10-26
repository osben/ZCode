import type { ToolExecutionResult } from "../../tool/types.js";
import { buildRepeatedToolCallSignature } from "./model-anomaly.js";

/**
 * Successful calls at least this long are treated as intentional waiting (covers `sleep 60 && …`).
 * Failed long calls still count: re-running the same slow failing build is the loop to catch.
 */
export const POLLING_MIN_DURATION_MS = 30_000;

const POLLING_TOOL_NAMES = new Set(["TaskOutput", "GetWorkflowRun"]);
const TASK_OUTPUT_PENDING_RETRIEVAL_STATUSES = new Set(["not_ready", "timeout"]);
const ROTATION_PERIODS = [2, 3] as const;
const MAX_ROTATION_PERIOD = 3;

/** Kept history: the longest run that can match, period 3 repeated `threshold` times (9 by default). */
export function toolLoopHistoryLimit(threshold: number): number {
  return MAX_ROTATION_PERIOD * threshold;
}

export interface ToolLoopHistoryEntry {
  modelStepIndex: number;
  signature: string;
  toolCallId: string;
  toolName: string;
}

export interface ToolLoopHistory {
  entries: ToolLoopHistoryEntry[];
  /** Fire-once latch: cleared when a rotation fires, re-armed only after the cycle breaks. */
  rotationArmed: boolean;
}

export interface ToolCallRotationObservation {
  cycles: number;
  period: number;
  threshold: number;
  toolCallId: string;
  toolName: string;
  toolNames: string[];
  warningInjected: boolean;
}

export interface ToolCallRotationConfig {
  repeatedToolCallWarningThreshold?: number;
  maxBudgetWarningsPerTurn?: number;
}

export interface AnomalyWarningBudget {
  anomalyWarningsInjected: number;
}

export function createToolLoopHistory(): ToolLoopHistory {
  return { entries: [], rotationArmed: true };
}

/**
 * Polling-shaped calls are exempt from loop detection: they neither advance nor reset the
 * exact-repeat streak or the rotation window. A call without a result (e.g. cancelled) counts
 * as a normal call, except for the name-based rule which does not need a result.
 */
export function isPollingToolCall(
  toolName: string,
  input: unknown,
  result: ToolExecutionResult | undefined,
): boolean {
  if (POLLING_TOOL_NAMES.has(toolName)) return true;
  if (result === undefined) return false;
  if (result.success && result.durationMs >= POLLING_MIN_DURATION_MS) return true;
  if (toolName === "TaskOutput" && isTaskOutputPendingResult(result.output)) return true;
  return toolName === "Bash" && result.success && isLogTailBashCommand(input);
}

function isTaskOutputPendingResult(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const retrievalStatus = (output as { retrieval_status?: unknown }).retrieval_status;
  return (
    typeof retrievalStatus === "string" &&
    TASK_OUTPUT_PENDING_RETRIEVAL_STATUSES.has(retrievalStatus)
  );
}

function isLogTailBashCommand(input: unknown): boolean {
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || command.trim() === "") return false;
  return command
    .split(/;|&&/)
    .every((segment) => isLogTailSegment(segment.trim()));
}

const POSIX_TAIL_SEGMENT =
  /^tail(?:\s+(?:-n\s+\d+|-\d+))?\s+("[^"]+"|'[^']+'|\S+)$/i;
const WINDOWS_TAIL_SEGMENT = /^get-content\s+-tail\s+\d+\s+("[^"]+"|'[^']+'|\S+)$/i;

function isLogTailSegment(segment: string): boolean {
  const matched =
    POSIX_TAIL_SEGMENT.exec(segment)?.[1] ?? WINDOWS_TAIL_SEGMENT.exec(segment)?.[1];
  if (matched === undefined) return false;
  const quoted = /^("[^"]*"|'[^']*')$/.test(matched);
  const path = quoted ? matched.slice(1, -1) : matched;
  if (!path.toLowerCase().endsWith(".log")) return false;
  // Only a literal path counts: metacharacters, substitutions or embedded quotes mean the
  // segment is not a plain log tail and must not escape loop detection. Unquoted tokens must
  // additionally be a single word.
  if (!quoted && /\s/.test(path)) return false;
  return !/[`$|<>()&;'"]/.test(path);
}

export function recordToolCallRotation(
  history: ToolLoopHistory,
  call: { id: string; name: string; input: unknown; modelStepIndex: number },
  budget: AnomalyWarningBudget,
  config: ToolCallRotationConfig | undefined,
): ToolCallRotationObservation | undefined {
  const threshold = config?.repeatedToolCallWarningThreshold ?? 3;
  if (threshold <= 0) return undefined;

  const entry: ToolLoopHistoryEntry = {
    modelStepIndex: call.modelStepIndex,
    signature: buildRepeatedToolCallSignature(call.name, call.input),
    toolCallId: call.id,
    toolName: call.name,
  };
  history.entries.push(entry);
  const limit = toolLoopHistoryLimit(threshold);
  if (history.entries.length > limit) {
    history.entries.splice(0, history.entries.length - limit);
  }

  const match = matchRotationRun(history.entries, threshold);
  if (match) {
    if (!history.rotationArmed) return undefined;
    history.rotationArmed = false;
    const maxBudgetWarningsPerTurn = config?.maxBudgetWarningsPerTurn ?? 3;
    const warningInjected = budget.anomalyWarningsInjected < maxBudgetWarningsPerTurn;
    if (warningInjected) {
      budget.anomalyWarningsInjected += 1;
    }
    const toolNames: string[] = [];
    for (const cycleEntry of match.entries.slice(0, match.period)) {
      if (!toolNames.includes(cycleEntry.toolName)) toolNames.push(cycleEntry.toolName);
    }
    return {
      cycles: threshold,
      period: match.period,
      threshold,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      toolNames,
      warningInjected,
    };
  }
  if (!history.rotationArmed) {
    history.rotationArmed = true;
  }
  return undefined;
}

interface RotationRunMatch {
  entries: ToolLoopHistoryEntry[];
  period: number;
}

function matchRotationRun(
  entries: readonly ToolLoopHistoryEntry[],
  threshold: number,
): RotationRunMatch | undefined {
  for (const period of ROTATION_PERIODS) {
    const needed = period * threshold;
    if (entries.length < needed) continue;
    const window = entries.slice(entries.length - needed);
    const cycleSignatures = window.slice(0, period).map((entry) => entry.signature);
    if (new Set(cycleSignatures).size !== period) continue;
    let cyclic = true;
    for (let index = period; index < needed; index += 1) {
      if (window[index].signature !== cycleSignatures[index % period]) {
        cyclic = false;
        break;
      }
    }
    if (!cyclic) continue;
    // A rotation inside one batched model response is a single decision, not a loop across
    // model steps; it must not fire.
    if (window[0].modelStepIndex === window[needed - 1].modelStepIndex) continue;
    return { entries: window, period };
  }
  return undefined;
}

export function buildToolCallRotationReminderBody(
  toolNames: readonly string[],
  period: number,
  cycles: number,
): string {
  return [
    `You have been cycling between ${toolNames.join(", ")} (period ${period}) ${cycles} times without progress.`,
    "Break the cycle: build on the results you already have, take a different next step, or explain the blocker and ask the user for guidance.",
  ].join("\n");
}
