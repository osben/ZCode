/**
 * NDJSON wire protocol (Boundary A transport encoding).
 *
 * The sandbox child process and parent harness communicate through newline-delimited JSON over
 * stdio. This module is the **single source of truth** for message kinds and fields. The child
 * source (an embedded string in child-source.ts) mirrors these shapes by hand because it cannot
 * import this module (`toString()` embeds it in the entry file), so both locations must be updated
 * together. The parent imports these types directly to keep bridge code strictly typed.
 *
 * Direction convention:
 *   child → parent: create-actor (fire-and-forget) / request (ask/world-read/publish-artifact, response required) /
 *                   event（log、report、declare-artifact）/ complete
 *   parent → child: response (answers a request and carries the latest budget snapshot)
 *
 * Why create-actor does not use request/response: Boundary A requires `createActor` to return a
 * handle **synchronously**. The child cannot wait for a round trip to return synchronously, so it
 * creates a child-local handle (`local#N`) and sends a create-actor message without waiting. Based
 * on stdio FIFO ordering, the parent maps local→engine ActorId before processing any ask that
 * references the handle (the parent's create-actor handler is fully synchronous).
 */

import type { ArtifactContentOp, ArtifactPresetOp, WorldReadOp } from "@zcode/dynamic-workflow";

// ————————————————————————————————————————————————————————————————
// Wire shape for structured errors
// ————————————————————————————————————————————————————————————————

/**
 * Error shape used across the boundary. A rejected ask (WorkflowError) crosses in this form, and
 * the child reconstructs an Error with `code`/`violations`/`finalText` inside the sandbox so the
 * script can handle it structurally in try/catch.
 * Model-side errors do not cross the boundary: they are either retried in the runtime or stop the
 * entire run, so the script never sees them.
 */
export interface WireError {
  name: string;
  message: string;
  code?: string;
  violations?: unknown[];
  finalText?: string;
  stack?: string;
}

// ————————————————————————————————————————————————————————————————
// child → parent
// ————————————————————————————————————————————————————————————————

/** Create an actor synchronously: send without waiting; FIFO lets the parent map local→ActorId before later asks. */
export interface CreateActorMessage {
  kind: "create-actor";
  localId: string;
  siteId: string;
  name?: string;
  persona?: unknown;
}

/**
 * Host calls that require a response: ask, world-read, or **publishing a content artifact**.
 *
 * The two artifact families diverge here: content members (`file`/`markdown`) have effects; the
 * script awaits them and must be able to catch rejections, so they use request/response. Preset
 * members are declarations that return void, so they use the event channel below.
 */
export interface RequestMessage {
  kind: "request";
  id: string;
  type: "ask" | "world-read" | "publish-artifact";
  siteId: string;
  /** ask only: child-local actor handle. */
  actor?: string;
  /** ask only: instruction body. */
  instructions?: string;
  /** world-read only: op (the vocabulary is derived from the world-read registry; adding a primitive does not change this file). */
  op?: WorldReadOp;
  /**
   * publish-artifact only: op for content members. **Intentionally kept in a separate field from
   * `op`** instead of widening `op` to a union of both vocabularies. With a wider type, the parent
   * would receive a value that must be narrowed again during dispatch, using only `type` as the
   * basis—which is exactly what these two fields already express. Two registries, two fields; no
   * guessing is needed.
   */
  artifactOp?: ArtifactContentOp;
  /**
   * world-read only: **positional argument array**. Lowering packages the arguments from the script
   * call site as-is, and this layer passes them through unchanged; arity and validation belong to
   * the driver.
   * A single-argument `arg?: string` cannot represent ops with multiple or no arguments
   * (`files.grep(pattern, glob?)`, `git.status()`).
   */
  args?: unknown[];
}

/**
 * Fire-and-forget events, discriminated by `type`. None need a response, but their **durability
 * differs**: losing a `log` only drops a line of chatter, while losing a `report` drops a finding
 * (the parent writes it to the journal). Therefore FIFO ordering on the event channel is critical
 * for reports—the parent journals what arrives.
 *
 * `declare-artifact` shares this channel with reports, and **must** do so: a tagged report is only
 * valid after its preset declaration has reached the parent (otherwise the engine fails the whole
 * run with `ArtifactUndeclared`). The script declares first and reports later; the same FIFO makes
 * the parent observe them in that order. Making declarations request/response would not improve
 * this guarantee; it would only add an unnecessary wait to a facade member that returns void
 * synchronously.
 */
export type EventMessage =
  | LogEventMessage
  | ReportEventMessage
  | DeclareArtifactEventMessage
  | PhaseEnteredEventMessage;

/**
 * Control flow passed a `phase("…")` marker. It uses the event channel: the script never awaits
 * it; it has no site and is not journaled, while the parent asks the engine to emit a
 * `phase-entered` event. Arrival order still matters—the timeline lights up based on “enter B
 * before dispatching an ask inside B.”
 */
export interface PhaseEnteredEventMessage {
  kind: "event";
  type: "phase-entered";
  /** The author's original label, trimmed by lowering. */
  name: string;
}

/** Progress message: no site and not journaled. */
export interface LogEventMessage {
  kind: "event";
  type: "log";
  message: string;
}

/**
 * An intermediate result. It uses the event channel rather than request/response because the
 * script never awaits it. Unlike `log`, the parent writes it as a `dwf_node` row by `siteId` ×
 * ordinal.
 */
export interface ReportEventMessage {
  kind: "event";
  type: "report";
  siteId: string;
  item: unknown;
  /**
   * Artifact label (`report(item, "perf")`): which preset artifact also receives this item. If
   * absent, there is no label (`JSON.stringify` drops the entire key when its value is undefined,
   * so the wire representation has “no such key”).
   */
  artifactId?: string;
}

/**
 * A **preset artifact declaration** (`artifact.chart`, etc.). It uses the event channel rather than
 * request/response because the facade member synchronously returns void—the script never awaits
 * it. The parent writes a `dwf_node` row by `siteId` × ordinal (except for idempotent duplicate
 * declarations), so this message's arrival order also matters (see {@link EventMessage}).
 */
export interface DeclareArtifactEventMessage {
  kind: "event";
  type: "declare-artifact";
  siteId: string;
  op: ArtifactPresetOp;
  /** Positional argument array (`[id, spec]`), packaged by lowering and passed through unchanged here. */
  args: unknown[];
}

/** Script execution completion: a top-level artifact or a thrown error. */
export interface CompleteMessage {
  kind: "complete";
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** All child → parent messages. */
export type ChildMessage = CreateActorMessage | RequestMessage | EventMessage | CompleteMessage;

// ————————————————————————————————————————————————————————————————
// parent → child
// ————————————————————————————————————————————————————————————————

/** Response to a request. */
export interface ResponseMessage {
  kind: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

/** All parent → child messages. */
export type ParentMessage = ResponseMessage;

/**
 * Initial payload for the child process. Embedded as a JSON literal in the entry file
 * (`renderChildEntry` in child-source.ts), rather than passed through argv/base64: the Windows
 * command-line limit is 32,767 characters.
 */
export interface ChildPayload {
  /** Async function body for the lowered script (the only free identifier is `__host`). */
  lowered: string;
  /**
   * Arguments for this run, injected into the sandbox as the **frozen** `args` global (lowering
   * rewrites reads of `args` in the script as `__host.args`).
   *
   * Crosses the boundary only once, at spawn, and is never updated afterward—the arguments are
   * constant for the run's entire lifetime. If absent, it is treated as `{}`: inline runs and old
   * journal rows both use this path, so `args.x` in the script is always a valid property read
   * rather than a crash.
   */
  args?: Record<string, unknown>;
  /**
   * Heap limit (MB). **Applies only on the argsPrefix (SEA re-exec) path**: that path cannot pass
   * `--max-old-space-size`; if the entry file does not see the flag in `execArgv`, it makes a
   * best-effort call to `v8.setFlagsFromString`. On the default path, the actual Node flag takes
   * effect and the entry file skips this field when it sees the flag.
   * The effect is not guaranteed (V8 may ignore flags already consumed during startup); this is
   * recorded as a SEA limitation.
   */
  maxOldSpaceSizeMb?: number;
}
