/**
 * mapToolStatus — maps ChatToolCall.status to the ToolPart["state"] expected by the ai-elements Tool component.
 *
 * Reason: the ai-elements Tool component uses the ai-sdk ToolUIPart/DynamicToolUIPart state enums,
 * while our ZCode Agent layer uses custom status strings. This mapping bridges the two.
 */
import type { ToolPart } from "../components/ai-elements/tool.js";

const statusMap: Record<string, ToolPart["state"]> = {
  pending: "input-streaming",
  in_progress: "input-available",
  completed: "output-available",
  failed: "output-error",
  stopped: "output-error",
  denied: "output-denied", // TODO: this field is not defined in the ZCode schema.
};

export function mapToolStatus(status: string): ToolPart["state"] {
  return statusMap[status] ?? "input-streaming";
}
