import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/** Validate ownership of execution records by their startup sessionId; even ancestor runtimes cannot read another session's workId. */
export async function readBackgroundBashOutput(
  this: AgentRuntimeInternal,
  workId: string,
  sessionId = this.sessionId as string,
): Promise<BackgroundBashOutputResult> {
  if (!this.executionPort?.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return this.executionPort.readBackgroundBashOutput(workId, sessionId);
}
