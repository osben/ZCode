import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
}

export interface CoordinatorResponsePort {
  // The port closure binds the child session/agent/parent identity, so the model cannot
  // override routing.
  // Synchronous return ensures the child tool result completes only after the response
  // command has entered the parent queue.
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
