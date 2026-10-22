/**
 * Tool rows of one external agent turn (specs/acp-agent-runtime.md "Chat delegation (phase 4)", S3).
 *
 * Each ACP tool call becomes a ZCode tool lifecycle (`ToolCallScheduled` → `Started` → `Progress`
 * → `Result` | `Error`) and a persisted `tool` part marked `metadata.externalAgent`. The plan
 * becomes a synthetic `TodoWrite` row and also writes the session todo state the todo panel reads.
 * The rows never reach the model: cold history hydration skips parts with that marker.
 */
import {
  SessionEventType,
  createPartId,
  createToolCallId,
  type MessageId,
  type PartId,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type {
  ExternalAgentPlanEntry,
  ExternalAgentToolUpdate,
  TodoItem,
  ToolState,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { summarizeTodos } from "../../tool/handlers/todo.js";

/** Output text kept per tool row. Longer output is cut and marked, so one tool cannot flood the transcript. */
export const EXTERNAL_AGENT_TOOL_OUTPUT_MAX_CHARS = 32 * 1024;
const TRUNCATION_MARKER = "\n… [truncated]";
const EXTERNAL_TOOL_ERROR_TYPE = "external_agent_tool_error";

type ToolCallIdValue = ReturnType<typeof createToolCallId>;

interface ToolRow {
  readonly toolCallId: ToolCallIdValue;
  readonly partId: PartId;
  readonly toolName: string;
  title: string;
  input: Record<string, unknown>;
  started: boolean;
  finished: boolean;
  startedAt: number;
}

export interface ExternalAgentToolRowsOptions {
  readonly agentId: string;
  readonly assistantMessageId: MessageId;
  readonly runtime: AgentRuntimeInternal;
  readonly traceContext: TraceContext;
  readonly turnTraceContext: TraceContext;
  /** The turn's event list: every event this class appends is also pushed here (the turn queue reads it). */
  readonly events: SessionEvent[];
}

export class ExternalAgentToolRows {
  readonly #options: ExternalAgentToolRowsOptions;
  /** ACP `toolCallId` → row, scoped to this turn. */
  readonly #rows = new Map<string, ToolRow>();
  readonly #open = new Set<ToolRow>();

  constructor(options: ExternalAgentToolRowsOptions) {
    this.#options = options;
  }

  /** Applies one `tool_call` (first sight) or `tool_call_update` to its row. */
  async apply(update: ExternalAgentToolUpdate, isUpdate: boolean): Promise<void> {
    let row = this.#rows.get(update.toolCallId);
    if (!row) {
      row = this.#createRow(`acp:${update.kind ?? "other"}`, update.title ?? "", toInput(update.input));
      this.#rows.set(update.toolCallId, row);
      await this.#schedule(row);
    }
    // A late update for a row that already closed is ignored: its lifecycle is complete.
    if (row.finished) return;
    if (update.title !== null) row.title = update.title;
    if (update.input !== undefined) row.input = toInput(update.input);
    const wasStarted = row.started;
    switch (update.status) {
      case "completed":
        await this.#start(row);
        await this.#finish(row, "completed", update.output);
        return;
      case "failed":
        await this.#start(row);
        await this.#finish(row, "failed", update.output);
        return;
      case "in_progress":
        await this.#start(row);
        break;
      default:
        break;
    }
    if (isUpdate && wasStarted) await this.#progress(row);
  }

  /**
   * The ZCode identity of an ACP tool call, for a permission ask. An ask for an id no update has
   * named yet creates its row first, so the prompt always anchors to a scheduled tool row.
   */
  async rowFor(acpToolCallId: string): Promise<{ toolCallId: ToolCallIdValue; toolName: string }> {
    let row = this.#rows.get(acpToolCallId);
    if (!row) {
      row = this.#createRow("acp:other", "", {});
      this.#rows.set(acpToolCallId, row);
      await this.#schedule(row);
    }
    return { toolCallId: row.toolCallId, toolName: row.toolName };
  }

  /** Writes the plan as a `TodoWrite` row and the session todo state in the same turn. */
  async applyPlan(entries: readonly ExternalAgentPlanEntry[]): Promise<void> {
    const todos = entries.map(toTodoItem);
    const row = this.#createRow("TodoWrite", "Plan", { todos });
    await this.#schedule(row);
    await this.#start(row);
    const store = this.#options.runtime.sessionStore;
    const sessionID = this.#options.runtime.sessionId;
    const oldTodos = (await store?.readTodos({ sessionID })) ?? [];
    await store?.updateTodos({ sessionID, todos });
    await this.#finish(
      row,
      "completed",
      JSON.stringify({ oldTodos, todos, summary: summarizeTodos(todos) }),
    );
  }

  /** Closes every row still open with an error, so no row keeps a spinner after the turn ends. */
  async closeOpen(reason: string): Promise<void> {
    for (const row of [...this.#open]) {
      await this.#start(row);
      await this.#finish(row, "failed", reason);
    }
  }

  #createRow(toolName: string, title: string, input: Record<string, unknown>): ToolRow {
    return {
      toolCallId: createToolCallId(),
      partId: createPartId(),
      toolName,
      title,
      input,
      started: false,
      finished: false,
      startedAt: 0,
    };
  }

  async #schedule(row: ToolRow): Promise<void> {
    this.#open.add(row);
    await this.#persist(row, {
      status: "pending",
      input: row.input,
      raw: JSON.stringify({ tool: row.toolName, input: row.input }),
    });
    await this.#append(SessionEventType.ToolCallScheduled, {
      toolCallId: row.toolCallId,
      assistantMessageId: this.#options.assistantMessageId,
      toolName: row.toolName,
      ...(row.title ? { title: row.title } : {}),
      input: row.input,
      dependencies: [],
      canRunParallel: false,
      schedule: {
        parallelGroups: [[row.toolCallId]],
        executionOrder: [row.toolCallId],
      },
    });
  }

  async #start(row: ToolRow): Promise<void> {
    if (row.started || row.finished) return;
    row.started = true;
    row.startedAt = Date.now();
    await this.#persist(row, {
      status: "running",
      input: row.input,
      title: row.title || row.toolName,
      time: { start: row.startedAt },
    });
    await this.#append(SessionEventType.ToolCallStarted, {
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      startedAt: new Date(row.startedAt),
    });
  }

  async #progress(row: ToolRow): Promise<void> {
    await this.#append(SessionEventType.ToolCallProgress, {
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      ...(row.title ? { message: row.title } : {}),
    });
  }

  async #finish(row: ToolRow, outcome: "completed" | "failed", text: string | null): Promise<void> {
    if (row.finished) return;
    row.finished = true;
    this.#open.delete(row);
    const end = Date.now();
    const duration = Math.max(0, end - row.startedAt);
    const output = capToolOutput(text ?? "");
    const metadata = { externalAgent: true };
    if (outcome === "completed") {
      await this.#persist(row, {
        status: "completed",
        input: row.input,
        output,
        title: row.title || row.toolName,
        metadata,
        time: { start: row.startedAt, end },
      });
      await this.#append(SessionEventType.ToolCallResult, {
        toolCallId: row.toolCallId,
        result: { success: true, content: output },
        duration,
      });
      return;
    }
    const message = output.length > 0 ? output : `${row.toolName} failed`;
    await this.#persist(row, {
      status: "error",
      input: row.input,
      error: message,
      metadata,
      time: { start: row.startedAt, end },
    });
    await this.#append(SessionEventType.ToolCallError, {
      toolCallId: row.toolCallId,
      error: { type: EXTERNAL_TOOL_ERROR_TYPE, message },
    });
  }

  async #persist(row: ToolRow, state: ToolState) {
    await this.#options.runtime.persistPart(
      {
        id: row.partId,
        sessionID: this.#options.runtime.sessionId,
        messageID: this.#options.assistantMessageId,
        type: "tool",
        callID: row.toolCallId,
        tool: row.toolName,
        metadata: { externalAgent: true },
        state,
      },
      this.#options.traceContext,
    );
  }

  async #append(type: SessionEventType, payload: unknown): Promise<void> {
    const runtime = this.#options.runtime;
    const event = runtime.createEvent(type, payload, this.#options.turnTraceContext);
    await runtime.appendEvent(event, this.#options.turnTraceContext);
    this.#options.events.push(event);
  }
}

function toInput(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { value: raw };
}

function capToolOutput(text: string): string {
  if (text.length <= EXTERNAL_AGENT_TOOL_OUTPUT_MAX_CHARS) return text;
  return text.slice(0, EXTERNAL_AGENT_TOOL_OUTPUT_MAX_CHARS) + TRUNCATION_MARKER;
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const TODO_PRIORITIES = new Set(["high", "medium", "low"]);

function toTodoItem(entry: ExternalAgentPlanEntry): TodoItem {
  return {
    content: entry.content.trim() || "Untitled step",
    status: (TODO_STATUSES.has(entry.status) ? entry.status : "pending") as TodoItem["status"],
    priority: (TODO_PRIORITIES.has(entry.priority)
      ? entry.priority
      : "medium") as TodoItem["priority"],
  };
}
