// ============================================================
// External agent turn port (specs/acp-agent-runtime.md "Chat delegation (phase 4)")
// ============================================================
// An `acp-agent` provider is an external process (ACP over stdio), not a model API. Its Model is
// a marker that carries a turn driver: core runs the turn through the driver and never imports the
// ACP runtime. The composition root (bootstrap) is the only place that binds the two together.

import type { Model, ModelOptions, ModelOptionSpecs, ModelProperties, ModelUsage } from "./index.js";

/** Symbol key under which a marker Model carries its turn driver. `Symbol.for` keeps bundles agreeing. */
export const EXTERNAL_AGENT_TURN_DRIVER: unique symbol = Symbol.for(
  "zcode.model.externalAgentTurnDriver",
);

/** Latest real user input of one turn, as ACP content blocks. */
export type ExternalAgentPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** ACP tool call status; `null` when the agent did not send one. */
export type ExternalAgentToolStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * One ACP `tool_call` or `tool_call_update` after mapping. Fields the agent omitted are `null`
 * (`input` is `undefined`); an update merges into the row the same `toolCallId` created.
 */
export interface ExternalAgentToolUpdate {
  /** ACP tool call id; core mints the ZCode id per turn. */
  readonly toolCallId: string;
  readonly title: string | null;
  /** ACP kind (`read`, `edit`, `execute`, ...); `null` maps to `other`. */
  readonly kind: string | null;
  readonly status: ExternalAgentToolStatus | null;
  readonly input: unknown;
  /** Text content of the update, when it carries any. */
  readonly output: string | null;
}

export interface ExternalAgentPlanEntry {
  readonly content: string;
  readonly priority: string;
  readonly status: string;
}

/** Streaming and session facts the driver reports while the agent works; ordering is the wire order. */
export type ExternalAgentTurnEvent =
  | { readonly type: "message_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly update: ExternalAgentToolUpdate }
  | { readonly type: "tool_call_update"; readonly update: ExternalAgentToolUpdate }
  | { readonly type: "plan"; readonly entries: readonly ExternalAgentPlanEntry[] }
  | { readonly type: "session_title"; readonly title: string };

/** A permission ask of the agent, after the runtime's live-turn check. */
export interface ExternalAgentPermissionAsk {
  readonly toolCallId: string;
  readonly title: string;
  readonly detail: string | null;
  /** Option kinds the agent offered. An answer is applied only through a matching kind. */
  readonly optionKinds: readonly string[];
}

/** The user's answer: `allow` maps to `allow_once`, `deny` to `reject_once`, anything else to `cancelled`. */
export type ExternalAgentPermissionAnswer = "allow" | "deny" | "cancelled";

export interface ExternalAgentTurnRequest {
  /** ZCode session that owns the resident agent process. */
  readonly sessionId: string;
  /** Agent working directory: the core working directory, never the workspace identity. */
  readonly workingDirectory: string;
  readonly prompt: readonly ExternalAgentPromptBlock[];
  /** Aborted by the turn lifecycle; the driver cancels the agent when it fires. */
  readonly signal: AbortSignal;
  readonly onEvent: (event: ExternalAgentTurnEvent) => void;
  /**
   * Asks the user through the turn's permission path (user-once only). Resolves `cancelled` on turn
   * abort. The driver answers the agent with the mapped kind; `allow_always` is never sent.
   */
  readonly requestPermission: (
    ask: ExternalAgentPermissionAsk,
  ) => Promise<ExternalAgentPermissionAnswer>;
}

export interface ExternalAgentTurnResult {
  readonly agentId: string;
  /** ACP `stopReason` of the prompt (e.g. `end_turn`, `cancelled`, `max_tokens`). */
  readonly stopReason: string;
  /** Usage reported by the agent, already mapped to ZCode usage names. */
  readonly usage?: ModelUsage;
}

export interface ExternalAgentTurnDriver {
  readonly agentId: string;
  /** Resolves on exactly one terminal outcome; rejects with `ExternalAgentTurnError` otherwise. */
  runTurn(request: ExternalAgentTurnRequest): Promise<ExternalAgentTurnResult>;
}

export type ExternalAgentTurnErrorCode =
  | "auth_required"
  | "agent_unavailable"
  | "prompt_failed"
  | "process_exited";

/** Failure of an external turn. `message` is user-facing and actionable. */
export class ExternalAgentTurnError extends Error {
  readonly code: ExternalAgentTurnErrorCode;

  constructor(code: ExternalAgentTurnErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExternalAgentTurnError";
    this.code = code;
  }
}

/**
 * Thrown by the marker's `generateText`/`streamText`. Side callers that would reach an external
 * agent through the regular model API fail closed with this error.
 */
export class ExternalAgentUnsupportedError extends Error {
  readonly code = "external_agent_unsupported" as const;

  constructor(modelId: string, caller?: string) {
    super(
      `Model ${modelId} is an external agent; ${caller ?? "the regular model API"} cannot run it (external_agent_unsupported)`,
    );
    this.name = "ExternalAgentUnsupportedError";
  }
}

export function externalAgentTurnDriverOf(model: Model): ExternalAgentTurnDriver | undefined {
  return (model as Partial<Record<typeof EXTERNAL_AGENT_TURN_DRIVER, ExternalAgentTurnDriver>>)[
    EXTERNAL_AGENT_TURN_DRIVER
  ];
}

export function isExternalAgentModel(model: Model | undefined): boolean {
  return model !== undefined && externalAgentTurnDriverOf(model) !== undefined;
}

/**
 * Side callers (title, memory, tools, verification) call the regular model API. An external-agent
 * model fails closed here, naming the caller, instead of reaching the agent process.
 */
export function assertNotExternalAgentModel<M extends Model>(model: M, caller: string): M {
  if (isExternalAgentModel(model)) throw new ExternalAgentUnsupportedError(String(model.modelId), caller);
  return model;
}

/**
 * Copies the driver of `source` onto `target`, a wrapper that rebuilds the Model object (invocation
 * context, off-peak and retry layers). Call before the wrapper is frozen.
 */
export function withExternalAgentTurnDriverOf<T extends Model>(source: Model, target: T): T {
  const driver = externalAgentTurnDriverOf(source);
  if (driver === undefined) return target;
  Object.defineProperty(target, EXTERNAL_AGENT_TURN_DRIVER, { value: driver, enumerable: false });
  return target;
}

export interface ExternalAgentModelInput {
  readonly driver: ExternalAgentTurnDriver;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;
}

/**
 * Builds the marker Model of an `acp-agent` provider. Its request methods fail closed; only the
 * chat turn path (core `runExternalAgentTurn`) drives the attached turn driver.
 */
export function createExternalAgentModel(input: ExternalAgentModelInput): Model {
  const unsupported = () => new ExternalAgentUnsupportedError(String(input.modelId));
  const model: Model = {
    providerId: input.providerId as Model["providerId"],
    modelId: input.modelId as Model["modelId"],
    displayName: input.displayName,
    properties: input.properties,
    optionSpecs: input.optionSpecs,
    options: input.options,
    bind(options?: ModelOptions) {
      return createExternalAgentModel({
        ...input,
        options: { ...input.options, ...options },
      });
    },
    generateText() {
      return Promise.reject(unsupported());
    },
    streamText() {
      // Fails on the first pull, like a stream that cannot start.
      return {
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(unsupported()) }),
      };
    },
  };
  Object.defineProperty(model, EXTERNAL_AGENT_TURN_DRIVER, {
    value: input.driver,
    enumerable: false,
  });
  return Object.freeze(model);
}
