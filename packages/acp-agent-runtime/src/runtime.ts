import { captureProcessTreeSnapshotAsync, terminateProcessTreeAndWait } from "@zcode/shared/node";
/* oxlint-disable eslint(max-lines) -- Lifecycle state machine: teardown, restarts and generation guards share one state owner by design. */
/**
 * AcpSessionRuntime — lifecycle owner for one external ACP agent process.
 *
 * Flow: spawn → initialize (protocol version check) → session/new → ready.
 * `prompt()` streams `session/update` events through `on("event", ...)` and
 * resolves when the turn stops. One active prompt per session; `cancel()` is
 * a bounded `session/cancel` with kill escalation; unexpected process death
 * or a fatal transport failure (oversized frame, closed stream) moves the
 * runtime to `failed` and the next `prompt()` restarts it.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  PROTOCOL_VERSION,
  client as createClientApp,
  methods,
  type ClientCapabilities,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  MessageTooLargeError,
} from "@agentclientprotocol/sdk";
import {
  AcpAgentDiedError,
  AcpCancelledError,
  AcpProtocolVersionError,
  AcpRuntimeError,
  AcpStateError,
  AcpStreamClosedError,
} from "./errors.js";
import { readTextFileViaBridge, writeTextFileViaBridge } from "./fs.js";
import { buildChildEnv, validateLaunchOptions } from "./launch.js";
import { buildPermissionAsk, toPermissionResponse } from "./permissions.js";
import { spawnAcpProcess, type SpawnedAcpProcess } from "./transport.js";
import { mapSessionUpdate } from "./updates.js";
import {
  CANCELLED_ANSWER,
  DEFAULT_TIMEOUTS,
  createDeferred,
  isConnectionClosedError,
  normalizeAuthMethods,
  raceTimeout,
  sleep,
  withTimeout,
  type Deferred,
} from "./runtime-helpers.js";
import type {
  AcpAuthMethod,
  AcpFrameObserver,
  AcpHostBridge,
  AcpLaunchOptions,
  AcpPermissionAnswer,
  AcpRuntimeEvent,
  AcpRuntimeState,
  AcpTimeouts,
} from "./types.js";

/** How long a closed stream/connection waits for the child's exit event
 * before the failure is classified as a dead connection with a live child. */
const DEATH_GRACE_MS = 1_000;

export interface AcpSessionRuntimeOptions extends AcpLaunchOptions {
  readonly timeouts?: AcpTimeouts;
  readonly maxFrameBytes?: number;
  /**
   * Raw NDJSON wire observer: called once per line, per direction, in wire
   * order. Lines over 16 KiB are truncated with a marker and observer
   * exceptions are swallowed (see `AcpRawFrame`).
   */
  readonly onFrame?: AcpFrameObserver;
}

interface ActivePromptState {
  readonly generation: number;
  stallEmitted: boolean;
  reject?: (reason?: unknown) => void;
}

export class AcpSessionRuntime extends EventEmitter {
  private termination: Promise<void> | undefined;
  private restarting: Promise<void> | undefined;
  private readonly options: AcpSessionRuntimeOptions;
  private readonly bridge: AcpHostBridge;
  private readonly timeouts: Required<AcpTimeouts>;
  private process: SpawnedAcpProcess | undefined;
  private connection: ClientConnection | undefined;
  private sessionId: string | undefined;
  private authMethods: readonly AcpAuthMethod[] = [];
  private configOptions: unknown = null;
  private generation = 0;
  /** Last generation whose process exit was handled outside an explicit stop; written only by `handleExit`. */
  private exitedGeneration = 0;
  private activePrompt: ActivePromptState | undefined;
  private readonly pendingAsks = new Map<string, Deferred<AcpPermissionAnswer>>();
  private stopRequested = false;
  private stallTimer: NodeJS.Timeout | undefined;
  private currentState: AcpRuntimeState = "starting";
  private ignoredUpdateCount = 0;

  private constructor(options: AcpSessionRuntimeOptions, bridge: AcpHostBridge) {
    super();
    this.options = options;
    this.bridge = bridge;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  /** Spawns the agent, performs the handshake and creates the first session. */
  static async start(
    options: AcpSessionRuntimeOptions,
    bridge: AcpHostBridge = {},
  ): Promise<AcpSessionRuntime> {
    const runtime = new AcpSessionRuntime(options, bridge);
    await runtime.connect();
    return runtime;
  }

  get state(): AcpRuntimeState {
    return this.currentState;
  }

  get acpSessionId(): string | undefined {
    return this.sessionId;
  }

  get acpAuthMethods(): readonly AcpAuthMethod[] {
    return this.authMethods;
  }

  get sessionConfigOptions(): unknown {
    return this.configOptions;
  }

  get ignoredUpdates(): number {
    return this.ignoredUpdateCount;
  }

  stderrTail(): string {
    return this.process?.stderrTail() ?? "";
  }

  /** Sends a prompt and resolves when the turn stops (one active prompt per session). */
  async prompt(text: string, blocks?: readonly ContentBlock[]): Promise<PromptResponse> {
    if (this.currentState === "failed") await this.restart();
    if (this.currentState !== "ready") {
      throw new AcpStateError(`Cannot prompt while the runtime is "${this.currentState}"`);
    }
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId) {
      throw new AcpStateError("ACP session is not established");
    }
    const active: ActivePromptState = {
      generation: this.generation,
      stallEmitted: false,
    };
    this.activePrompt = active;
    this.currentState = "prompting";
    this.resetStallTimer(active);
    const promptBlocks: ContentBlock[] = blocks ? [...blocks] : [{ type: "text", text }];
    try {
      const response = await new Promise<PromptResponse>((resolve, reject) => {
        active.reject = reject;
        connection.agent
          .request(methods.agent.session.prompt, { sessionId, prompt: promptBlocks })
          .then(resolve, reject);
      });
      this.emitEvent({
        type: "stopped",
        reason: response.stopReason,
        usage: response.usage ?? null,
      });
      return response;
    } catch (error) {
      throw await this.normalizePromptError(error);
    } finally {
      this.clearStallTimer();
      if (this.activePrompt === active) this.activePrompt = undefined;
      if (this.currentState === "prompting") this.currentState = "ready";
    }
  }

  /** Requests `session/cancel`; kills the process when the turn does not settle in time. */
  async cancel(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    const active = this.activePrompt;
    const generation = this.generation;
    if (!connection || !sessionId || !active) return;
    // One deadline bounds the whole cancel: a notify write can stay pending
    // forever when a live child stops reading stdin (backpressured pipe), and
    // a closed connection rejects. Escalate on either instead of hanging.
    const deadline = Date.now() + this.timeouts.cancelGraceMs;
    // `raceTimeout` maps any settlement to `true`, so race the notify directly
    // to keep `false` on a timeout or a rejected write.
    const notified = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.timeouts.cancelGraceMs);
      timer.unref?.();
      connection.agent.notify(methods.agent.session.cancel, { sessionId }).then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
    // The cancelled prompt settled (or was replaced) while the notify raced;
    // never escalate against a newer prompt or a restarted runtime.
    if (this.activePrompt !== active || this.generation !== generation) return;
    if (!notified) {
      await this.terminateProcess(
        new AcpCancelledError("Cancel notification failed or did not flush"),
      );
      return;
    }
    const settled = await this.waitForPromptSettle(deadline - Date.now(), active);
    if (!settled) {
      await this.terminateProcess(new AcpCancelledError("Prompt did not settle after cancel"));
    }
  }

  /** Gracefully stops the runtime; safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.currentState === "stopped") return this.termination;
    this.stopRequested = true;
    this.currentState = "stopped";
    this.resolvePendingAsks(CANCELLED_ANSWER);
    this.clearStallTimer();
    await this.terminateProcess(new AcpCancelledError("Runtime stopped"));
  }

  /** Re-launches the agent and a fresh session after an unexpected death. */
  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    if (this.currentState !== "failed") return Promise.resolve();
    this.stopRequested = false;
    const pending = (async () => {
      if (this.process || this.termination) {
        await this.terminateProcess(
          new AcpCancelledError("Cleaning the previous agent before restart"),
        );
      }
      if (this.stopRequested) return;
      this.currentState = "starting";
      await this.connect();
    })().finally(() => {
      if (this.restarting === pending) this.restarting = undefined;
    });
    this.restarting = pending;
    return pending;
  }

  private async connect(): Promise<void> {
    const launch = validateLaunchOptions(this.options);
    const env = buildChildEnv(process.env, launch.env);
    const proc = spawnAcpProcess({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env,
      ...(this.options.maxFrameBytes !== undefined
        ? { maxFrameBytes: this.options.maxFrameBytes }
        : {}),
      ...(this.options.onFrame !== undefined ? { onFrame: this.options.onFrame } : {}),
    });
    this.process = proc;
    this.generation += 1;
    // Scope both callbacks to this process generation: a restart may start while the previous child is still exiting.
    const generation = this.generation;
    proc.child.once("exit", (code, signal) => this.handleExit(code, signal, generation));
    // A framing failure (e.g. an oversized frame) errors the SDK connection
    // while the child can stay alive; a stdout close has the same effect. Run
    // the same teardown as a child exit so the runtime never sits on a dead
    // connection in "ready".
    proc.streamFailure.catch((error: Error) => this.handleStreamFailure(error, generation));

    const app = createClientApp({ name: `zcode-acp-agent-runtime (${launch.agentId})` })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.handlePermissionRequest(ctx.params, generation),
      )
      .onNotification(methods.client.session.update, (ctx) =>
        this.handleSessionUpdate(ctx.params, generation),
      );
    const fsBridge = this.bridge.fs;
    if (fsBridge) {
      app.onRequest(methods.client.fs.readTextFile, (ctx) =>
        readTextFileViaBridge(fsBridge, ctx.params),
      );
      app.onRequest(methods.client.fs.writeTextFile, (ctx) =>
        writeTextFileViaBridge(fsBridge, ctx.params),
      );
    }
    const connection = app.connect(proc.stream);
    this.connection = connection;

    try {
      const capabilities: ClientCapabilities = fsBridge
        ? { fs: { readTextFile: true, writeTextFile: true } }
        : {};
      const init = await this.raceSpawn(
        withTimeout(
          connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: capabilities,
          }),
          this.timeouts.initializeMs,
          "initialize",
        ),
      );
      this.assertProtocolVersion(init);
      this.authMethods = normalizeAuthMethods(init);
      if (this.authMethods.length > 0) this.bridge.onAuthMethods?.(this.authMethods);
      const session: NewSessionResponse = await this.raceSpawn(
        withTimeout(
          connection.agent.request(methods.agent.session.new, {
            cwd: launch.cwd,
            mcpServers: [],
          }),
          this.timeouts.newSessionMs,
          "session/new",
        ),
      );
      if (
        this.process !== proc ||
        this.currentState === "failed" ||
        this.currentState === "stopped"
      ) {
        // An exit or stream failure tore this generation down (the exit
        // event is not part of raceSpawn) while the session/new response
        // was in flight; never resurrect the dead session as "ready".
        throw new AcpAgentDiedError("Agent terminated during the handshake");
      }
      this.sessionId = session.sessionId;
      this.configOptions =
        (session as unknown as { configOptions?: unknown }).configOptions ?? null;
      this.currentState = this.stopRequested ? "stopped" : "ready";
    } catch (error) {
      this.currentState = this.stopRequested ? "stopped" : "failed";
      // handleExit tears the connection down, so an in-flight handshake request usually rejects
      // with a transport error before the commit guard above runs; report the death instead.
      const failure =
        this.exitedGeneration === generation &&
        !this.stopRequested &&
        !(error instanceof AcpAgentDiedError)
          ? new AcpAgentDiedError("Agent terminated during the handshake", { cause: error })
          : error;
      await this.terminateProcess(new AcpCancelledError("Handshake failed"));
      throw failure;
    }
  }

  private raceSpawn<T>(operation: Promise<T>): Promise<T> {
    const proc = this.process;
    if (!proc) return operation;
    return Promise.race([operation, proc.spawnFailure, proc.streamFailure]);
  }

  private assertProtocolVersion(init: InitializeResponse): void {
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpProtocolVersionError(PROTOCOL_VERSION, init.protocolVersion);
    }
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    generation: number,
  ): Promise<RequestPermissionResponse> {
    if (
      generation !== this.generation ||
      this.currentState !== "prompting" ||
      request.sessionId !== this.sessionId
    ) {
      // Stale (restarted), orphaned (torn down, out-of-turn) or
      // foreign-session asks never reach the host; answer them as cancelled.
      return toPermissionResponse(request, CANCELLED_ANSWER);
    }
    const askBridge = this.bridge.requestPermission;
    if (!askBridge) return toPermissionResponse(request, CANCELLED_ANSWER);
    const requestId = `${generation}:${request.toolCall.toolCallId}:${randomUUID()}`;
    const deferred = createDeferred<AcpPermissionAnswer>();
    this.pendingAsks.set(requestId, deferred);
    try {
      const ask = buildPermissionAsk(request, requestId);
      const answer = await Promise.race([
        askBridge(ask).catch(() => CANCELLED_ANSWER),
        deferred.promise,
      ]);
      if (this.generation !== generation || this.currentState !== "prompting") {
        // The runtime restarted, stopped or settled while the host was
        // deciding; never apply a stale decision.
        return toPermissionResponse(request, CANCELLED_ANSWER);
      }
      return toPermissionResponse(request, answer);
    } finally {
      this.pendingAsks.delete(requestId);
    }
  }

  private handleSessionUpdate(notification: SessionNotification, generation: number): void {
    if (generation !== this.generation) {
      // Buffered update from a superseded process: counted, never surfaced,
      // even when its sessionId collides with the new session's.
      this.ignoredUpdateCount += 1;
      return;
    }
    if (notification.sessionId !== this.sessionId) {
      // Updates for other sessions (sub-agents, stale sessions) are counted, not surfaced.
      this.ignoredUpdateCount += 1;
      return;
    }
    this.resetStallTimer(this.activePrompt);
    const event = mapSessionUpdate(notification.update);
    if (event) this.emitEvent(event);
    else this.ignoredUpdateCount += 1;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
    // A superseded process must not emit events or touch the current session.
    if (generation !== this.generation) return;
    this.emitEvent({ type: "process_exit", code, signal });
    this.resolvePendingAsks(CANCELLED_ANSWER);
    this.clearStallTimer();
    if (this.stopRequested || this.currentState === "stopped") return;
    this.currentState = "failed";
    this.exitedGeneration = generation;
    const died = new AcpAgentDiedError(
      `Agent process exited (code=${String(code)}, signal=${String(signal)})`,
    );
    this.activePrompt?.reject?.(died);
    void this.terminateProcess(died).catch((error: unknown) => this.reportCleanupFailure(error));
  }

  /**
   * Normalizes "connection closed" rejections into `AcpAgentDiedError` when
   * the process actually died; intentional stops keep the original error.
   * Fatal transport failures (`MessageTooLargeError`, a closed connection
   * whose child survives) tear the process down before returning, so
   * `prompt()`'s `finally` cannot restore "ready" on a dead connection.
   */
  private async normalizePromptError(error: unknown): Promise<unknown> {
    if (error instanceof AcpRuntimeError) return error;
    if (this.currentState === "stopped") return error;
    const framingError = error instanceof MessageTooLargeError;
    const closedError = !framingError && error instanceof Error && isConnectionClosedError(error);
    if (closedError) {
      const deadline = Date.now() + DEATH_GRACE_MS;
      while (Date.now() < deadline && this.currentState !== "failed") {
        await sleep(10);
      }
      if (this.currentState === "failed") {
        return new AcpAgentDiedError("Agent process died during the prompt", { cause: error });
      }
    }
    if (
      this.currentState === "prompting" &&
      (framingError || closedError || this.connection?.signal.aborted === true)
    ) {
      // The SDK connection is unusable while the child may still be alive:
      // mark the runtime failed and kill the process so the next prompt
      // restarts instead of reusing the dead connection.
      await this.terminateProcess(
        error instanceof Error ? error : new Error(`ACP transport failure: ${String(error)}`),
      );
    }
    return error;
  }

  /** Entry point for `streamFailure`: framing errors and stdout closes. */
  private handleStreamFailure(error: Error, generation: number): void {
    if (generation !== this.generation) return;
    if (this.stopRequested || this.currentState === "stopped") return;
    if (this.currentState === "failed") return;
    void this.teardownAfterStreamFailure(error, generation).catch((cleanupError: unknown) =>
      this.reportCleanupFailure(cleanupError),
    );
  }

  private reportCleanupFailure(error: unknown): void {
    this.emitEvent({
      type: "process_cleanup_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async teardownAfterStreamFailure(error: Error, generation: number): Promise<void> {
    if (error instanceof AcpStreamClosedError) {
      // A plain EOF usually means the child is dying: give the exit handler a
      // short window so a real death is still reported as `AcpAgentDiedError`.
      const deadline = Date.now() + DEATH_GRACE_MS;
      while (Date.now() < deadline && this.currentState !== "failed") {
        await sleep(10);
      }
      if (this.currentState === "failed" || this.currentState === "stopped") return;
    }
    // A restart may have created a new generation during the grace window.
    if (generation !== this.generation) return;
    await this.terminateProcess(error);
  }

  private resetStallTimer(active: ActivePromptState | undefined): void {
    this.clearStallTimer();
    if (!active || active.stallEmitted || this.timeouts.stallWarningMs <= 0) return;
    const silentMs = this.timeouts.stallWarningMs;
    this.stallTimer = setTimeout(() => {
      if (this.activePrompt !== active || active.stallEmitted) return;
      active.stallEmitted = true;
      this.emitEvent({ type: "stalled", silentMs });
    }, silentMs);
    this.stallTimer.unref?.();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
    }
  }

  private resolvePendingAsks(answer: AcpPermissionAnswer): void {
    for (const deferred of this.pendingAsks.values()) deferred.resolve(answer);
    this.pendingAsks.clear();
  }

  /** Waits until `watched` is no longer the active prompt (settled or replaced). */
  private async waitForPromptSettle(ms: number, watched: ActivePromptState): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.activePrompt !== watched) return true;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return this.activePrompt !== watched;
  }

  private terminateProcess(reason: Error): Promise<void> {
    if (this.termination) return this.termination;
    const owned = this.process;
    const pending = this.terminateOwnedProcess(reason)
      .catch((error: unknown) => {
        // Failed inspection/cleanup must retain ownership so another stop can retry safely.
        this.process ??= owned;
        this.currentState = "failed";
        throw error;
      })
      .finally(() => {
        if (this.termination === pending) this.termination = undefined;
      });
    this.termination = pending;
    return pending;
  }

  private async terminateOwnedProcess(reason: Error): Promise<void> {
    // The session is unusable from here on: mark the runtime failed (unless an
    // explicit stop already did) BEFORE rejecting the in-flight prompt, so the
    // prompt's `finally` cannot flip a torn-down runtime back to "ready" — a
    // later prompt then restarts instead of failing with ACP_STATE.
    if (this.currentState !== "stopped") this.currentState = "failed";
    const proc = this.process;
    this.process = undefined;
    const active = this.activePrompt;
    this.activePrompt = undefined;
    active?.reject?.(reason);
    const deadline = Date.now() + this.timeouts.stopGraceMs + this.timeouts.killGraceMs + 2500;
    const ownership = proc
      ? {
          ...(process.platform === "win32" ? {} : { ownedProcessGroupId: proc.child.pid }),
          ownedProcessStartedAtMs: proc.ownedProcessStartedAtMs,
          resolveOwnedProcessExitedAtMs: proc.resolveOwnedProcessExitedAtMs,
          windowsCleanupDeadlineAtMs: deadline,
        }
      : {};
    // After Node reaps the root, its PID may already belong to an unrelated process. The POSIX
    // snapshot looks the root up by bare PID, so only capture it while the child is unreaped;
    // the terminator then falls back to the owned process group. Windows filters by lifetime.
    const rootReaped = proc
      ? proc.child.exitCode !== null || proc.child.signalCode !== null
      : false;
    const snapshot =
      proc && (process.platform === "win32" || !rootReaped)
        ? await captureProcessTreeSnapshotAsync(proc.child, ownership)
        : undefined;
    try {
      this.connection?.close();
    } catch {
      // Closing an already-closed connection is fine.
    }
    this.connection = undefined;
    this.sessionId = undefined;
    if (!proc) return;
    try {
      proc.child.stdin?.end();
    } catch {
      // stdin may already be closed.
    }
    await raceTimeout(proc.exited, this.timeouts.stopGraceMs);
    const result = await terminateProcessTreeAndWait(proc.child, {
      ...ownership,
      ...(snapshot ? { snapshot } : {}),
      forceAfterMs: this.timeouts.killGraceMs,
      waitAfterForceMs: 500,
      windowsTaskkillTimeoutMs: 2000,
    });
    if (result.remainingPids.length > 0) {
      this.process = proc;
      this.currentState = "failed";
      throw new AcpStateError(`ACP process cleanup incomplete: ${result.remainingPids.join(", ")}`);
    }
  }

  private emitEvent(event: AcpRuntimeEvent): void {
    this.emit("event", event);
  }
}
