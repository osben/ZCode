import type { McpElicitationRequest, McpElicitationResult } from "@zcode/contracts";

/** The pipe tool call a question attaches to: its session and turn, and its tool use id (`zcode/toolUseId`). */
export interface ElicitationCallContext {
  sessionId: string;
  turnId?: string;
  toolUseId?: string;
}

/** `helper/elicitation`'s params, minus the request key the client adds (spec F3b(c) PR 2). */
export interface ElicitationAskParams extends Record<string, unknown> {
  sessionId: string;
  turnId?: string;
  toolUseId: string;
  server: string;
  message: string;
  requestedSchema?: unknown;
}

/** Sends `helper/elicitation`; aborting `signal` abandons the question at Rust (`helper/cancelRequest`). */
export type ElicitationAsk = (
  params: ElicitationAskParams,
  signal: AbortSignal,
) => Promise<unknown>;

const SUPPORTED_MODES: ReadonlySet<unknown> = new Set(["form", "openai/form", "openaiForm"]);

interface OpenCall {
  context: ElicitationCallContext;
  /** The questions asked during the call and not yet answered; ending the call abandons them. */
  asks: Set<AbortController>;
}

/**
 * The helper's relay of a helper-hosted server's `elicitation/create` to Rust's prompt (specs/fork-rust-node-helper.md,
 * "Elicitation from helper-hosted servers"). Node attaches a question to the session of the server's active call
 * (`activeCallTraces`); the pipe path has no trace, so the helper registers each in-flight pipe `tools/call` here, with
 * the context of its `zcode/helperContext`. A question attaches to the newest call of its server, and is declined when
 * no call is in flight, when the call names no tool use, or for a mode other than form (Node's `isSupportedElicitationMode`).
 * A question still open when its call ends is abandoned, and the server gets `cancel`.
 */
export class ElicitationRelay {
  private readonly calls = new Map<string, OpenCall[]>();

  constructor(private readonly ask: ElicitationAsk) {}

  /** Registers an in-flight pipe call of `server`; the returned function ends it. */
  enterCall(server: string, context: ElicitationCallContext): () => void {
    const call: OpenCall = { context, asks: new Set() };
    const open = this.calls.get(server) ?? [];
    open.push(call);
    this.calls.set(server, open);
    return () => {
      for (const ask of call.asks) ask.abort(new Error("The tool call ended"));
      call.asks.clear();
      const remaining = (this.calls.get(server) ?? []).filter((other) => other !== call);
      if (remaining.length > 0) this.calls.set(server, remaining);
      else this.calls.delete(server);
    };
  }

  /** The answer to the server's `elicitation/create`, in the MCP result's terms. */
  async elicit(request: McpElicitationRequest): Promise<McpElicitationResult> {
    const mode = (request as { mode?: unknown }).mode;
    if (mode !== undefined && !SUPPORTED_MODES.has(mode)) return { action: "decline" };
    const call = this.calls.get(request.serverName)?.at(-1);
    if (!call?.context.toolUseId) return { action: "decline" };
    const controller = new AbortController();
    call.asks.add(controller);
    try {
      const answer = (await this.ask(
        {
          sessionId: call.context.sessionId,
          ...(call.context.turnId ? { turnId: call.context.turnId } : {}),
          toolUseId: call.context.toolUseId,
          server: request.serverName,
          message: request.message,
          requestedSchema: request.requestedSchema,
        },
        controller.signal,
      )) as { action?: unknown; content?: unknown } | undefined;
      if (answer?.action === "accept")
        return {
          action: "accept",
          content: (answer.content ?? {}) as Record<string, unknown>,
        };
      if (answer?.action === "cancel") return { action: "cancel" };
      return { action: "decline" };
    } catch {
      // The call ended while the question was open: the server is told the question was cancelled.
      return controller.signal.aborted ? { action: "cancel" } : { action: "decline" };
    } finally {
      call.asks.delete(controller);
    }
  }
}
