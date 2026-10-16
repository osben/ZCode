/**
 * Mapping of ACP `session/update` notifications to runtime events.
 *
 * Unknown or not-yet-supported update kinds return `null`; the runtime counts
 * them so behavior stays observable without crashing on protocol drift.
 */
import type { SessionUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AcpPlanEntry, AcpRuntimeEvent, AcpToolCallInfo } from "./types.js";

/** Maps one `session/update` payload; returns `null` when nothing is surfaced. */
export function mapSessionUpdate(update: SessionUpdate): AcpRuntimeEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (content.type !== "text") return null;
      return { type: "message_chunk", text: content.text };
    }
    case "agent_thought_chunk": {
      const content = update.content;
      if (content.type !== "text") return null;
      return { type: "thought_chunk", text: content.text };
    }
    case "tool_call":
      return { type: "tool_call", toolCall: toToolCallInfo(update) };
    case "tool_call_update":
      return { type: "tool_call_update", toolCall: toToolCallInfo(update) };
    case "plan":
      return { type: "plan", entries: update.entries.map(toPlanEntry), raw: update };
    case "usage_update":
      return {
        type: "usage",
        used: update.used,
        size: update.size,
        cost: update.cost ?? null,
        raw: update,
      };
    case "session_info_update":
      return typeof update.title === "string"
        ? { type: "session_title", title: update.title }
        : null;
    case "available_commands_update":
      return { type: "available_commands", commands: update.availableCommands };
    default:
      return null;
  }
}

function toToolCallInfo(update: ToolCall | ToolCallUpdate): AcpToolCallInfo {
  return {
    toolCallId: update.toolCallId,
    title: typeof update.title === "string" ? update.title : "",
    kind: update.kind ?? null,
    status: update.status ?? null,
    raw: update,
  };
}

function toPlanEntry(entry: { content: string; priority: string; status: string }): AcpPlanEntry {
  return { content: entry.content, priority: entry.priority, status: entry.status };
}
