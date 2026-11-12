import type { CompactTrigger, HookRunResult, Model, TraceContext, TurnState } from "./deps.js";

// Split out from internal-methods.ts to keep that file within the 400-line limit
// enforced by the runtime-module-boundary test; hook methods form a cohesive group in their own file.
export interface AgentRuntimeHookMethods {
  runSessionStartHooks(
    source: "startup" | "resume" | "fork" | "clear" | "compact",
    traceContext: TraceContext,
    signal?: AbortSignal,
    model?: Pick<Model, "providerId" | "modelId">,
  ): Promise<HookRunResult>;
  runUserPromptSubmitHooks(
    prompt: string,
    attachments: TurnState["attachments"] | undefined,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runStopHooks(
    response: string,
    toolCallCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
    stopHookActive?: boolean,
  ): Promise<HookRunResult>;
  runPreCompactHooks(
    trigger: CompactTrigger,
    customInstructions: string | undefined,
    preCompactTokenCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPostCompactHooks(
    trigger: CompactTrigger,
    preCompactTokenCount: number,
    postCompactTokenCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runSessionEndHooks(traceContext: TraceContext): Promise<HookRunResult>;
  shouldContinueAfterStopHooks(result: HookRunResult, continuationCount: number): boolean;
}
