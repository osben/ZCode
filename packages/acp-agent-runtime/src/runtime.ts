/* oxlint-disable eslint(max-lines) -- Lifecycle state machine: teardown, restarts and generation guards share one state owner by design. */
/**
 * AcpSessionRuntime — lifecycle owner for one external ACP agent process.
 *
 * Flow: spawn → initialize → session/load or session/new → ready. `prompt()` streams
 * `session/update` events and resolves when the turn stops. `cancel()` is a bounded
 * `session/cancel` with kill escalation. Process death or a fatal transport failure marks the
 * runtime `failed`; the next `prompt()` restarts it.
 */
import { EventEmitter } from "node:events";
import {
  methods,
  type ClientConnection,
  type ContentBlock,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AcpAgentDiedError,
  AcpCancelledError,
  AcpStateError,
  AcpStreamClosedError,
} from "./errors.js";
import { validateLaunchOptions } from "./launch.js";
import { answerPermissionRequest, cancelPendingAsks } from "./permissions.js";
import { AcpConfigState } from "./runtime-config.js";
import {
  connectAcpClient,
  performAcpHandshake,
  raceProcessFailures,
  spawnAcpAgentProcess,
} from "./runtime-handshake.js";
import { AcpSessionResume, type AcpSessionStart } from "./runtime-resume.js";
import {
  normalizeAcpPromptError,
  planAcpProcessTeardown,
  runAcpCancel,
  runAcpProcessTeardown,
} from "./runtime-teardown.js";
import type { SpawnedAcpProcess } from "./transport.js";
import {
  DEATH_GRACE_MS,
  DEFAULT_TIMEOUTS,
  StallWatch,
  createRuntimeLog,
  errorMessage,
  normalizeAuthMethods,
  waitUntil,
  type ActivePromptState,
  type Deferred,
} from "./runtime-helpers.js";
import type {
  AcpAuthMethod,
  AcpConfigOption,
  AcpHostBridge,
  AcpPermissionAnswer,
  AcpRuntimeEvent,
  AcpRuntimeState,
  AcpSessionRuntimeOptions,
  AcpTimeouts,
} from "./types.js";

export class AcpSessionRuntime extends EventEmitter {
  private termination: Promise<void> | undefined;
  private restarting: Promise<void> | undefined;
  private readonly options: AcpSessionRuntimeOptions;
  private readonly bridge: AcpHostBridge;
  private readonly timeouts: Required<AcpTimeouts>;
  private readonly resume: AcpSessionResume;
  private process: SpawnedAcpProcess | undefined;
  private connection: ClientConnection | undefined;
  private sessionId: string | undefined;
  private authMethods: readonly AcpAuthMethod[] = [];
  private generation = 0;
  /** Last generation whose process exit was handled outside an explicit stop; written only by `handleExit`. */
  private exitedGeneration = 0;
  private activePrompt: ActivePromptState | undefined;
  private readonly pendingAsks = new Map<string, Deferred<AcpPermissionAnswer>>();
  private stopRequested = false;
  private readonly stallWatch: StallWatch;
  private readonly log: ReturnType<typeof createRuntimeLog>;
  private currentState: AcpRuntimeState = "starting";
  private ignoredUpdateCount = 0;
  private readonly config = new AcpConfigState();

  private constructor(options: AcpSessionRuntimeOptions, bridge: AcpHostBridge) {
    super();
    this.options = options;
    this.bridge = bridge;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.resume = new AcpSessionResume(options.resumeSessionId);
    this.stallWatch = new StallWatch(
      this.timeouts.stallWarningMs,
      (silentMs) => this.emitEvent({ type: "stalled", silentMs }),
      () => this.emitEvent({ type: "resumed" }),
    );
    this.log = createRuntimeLog(options.logger, options.agentId);
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

  /** How the latest session began; read once per connect. */
  takeSessionStart(): AcpSessionStart | undefined {
    return this.resume.take();
  }

  /** Select options of the latest session (spec S6). */
  /** The handshake's offered options with their starting values; choices set later do not change it (S6 readiness). */
  get handshakeConfigOptions(): readonly AcpConfigOption[] {
    return this.config.handshakeOptions;
  }

  get configOptions(): readonly AcpConfigOption[] {
    return this.config.options;
  }

  /** Sets one option (spec S6, `AcpConfigState.set`); throws `AcpStateError` unless "ready". */
  async setConfigOption(configId: string, value: string): Promise<readonly AcpConfigOption[]> {
    const { connection, sessionId, generation } = this;
    if (this.currentState !== "ready" || !connection || !sessionId) {
      throw new AcpStateError(`Cannot set a config option while "${this.currentState}"`);
    }
    return this.config.set({
      connection,
      sessionId,
      configId,
      value,
      timeoutMs: this.timeouts.newSessionMs,
      race: (operation) => raceProcessFailures(this.process, operation),
      isCurrent: () => generation === this.generation && sessionId === this.sessionId,
    });
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
    this.armStallWatch(active);
    const promptBlocks: ContentBlock[] = blocks ? [...blocks] : [{ type: "text", text }];
    let response: PromptResponse;
    try {
      response = await new Promise<PromptResponse>((resolve, reject) => {
        active.reject = reject;
        connection.agent
          .request(methods.agent.session.prompt, { sessionId, prompt: promptBlocks })
          .then(resolve, reject);
      });
    } catch (error) {
      const normalized = await this.normalizePromptError(error);
      this.settlePromptState(active);
      this.emitEvent({ type: "prompt_failed", message: errorMessage(normalized) });
      throw normalized;
    }
    this.settlePromptState(active);
    this.emitEvent({
      type: "stopped",
      reason: response.stopReason,
      usage: response.usage ?? null,
    });
    return response;
  }

  private settlePromptState(active: ActivePromptState): void {
    this.stallWatch.clear();
    if (this.activePrompt === active) this.activePrompt = undefined;
    if (this.currentState === "prompting") this.currentState = "ready";
  }

  /** Requests `session/cancel`; kills the process when the turn does not settle in time. */
  async cancel(): Promise<void> {
    const { connection, sessionId, activePrompt: active, generation } = this;
    if (!connection || !sessionId || !active) return;
    cancelPendingAsks(this.pendingAsks);
    await runAcpCancel({
      notify: () => connection.agent.notify(methods.agent.session.cancel, { sessionId }),
      graceMs: this.timeouts.cancelGraceMs,
      isSameTurn: () => this.activePrompt === active && this.generation === generation,
      isSettled: () => this.activePrompt !== active,
      terminate: (reason) => this.terminateProcess(reason),
    });
  }

  /** Gracefully stops the runtime; safe to call multiple times. */
  async stop(): Promise<void> {
    // Still owning a process after a failed cleanup: retry.
    if (this.currentState === "stopped" && !this.process) return this.termination;
    this.stopRequested = true;
    this.currentState = "stopped";
    cancelPendingAsks(this.pendingAsks);
    this.stallWatch.clear();
    await this.terminateProcess(new AcpCancelledError("Runtime stopped"));
  }

  /** Re-launches the agent and a fresh session after an unexpected death. */
  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    // `stopRequested` is write-once (only `stop()` sets it): a restart never undoes a stop.
    if (this.currentState !== "failed" || this.stopRequested) return Promise.resolve();
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
    // Scope every callback to this process generation: a restart may start while the previous child is still exiting.
    const generation = this.generation + 1;
    let proc: SpawnedAcpProcess;
    try {
      proc = spawnAcpAgentProcess(launch, {
        ...this.options,
        // Spec: any inbound frame data resets the stall timer.
        onInboundActivity: () => {
          if (generation === this.generation && this.activePrompt) {
            this.armStallWatch(this.activePrompt);
          }
        },
      });
    } catch (error) {
      this.currentState = this.stopRequested ? "stopped" : "failed";
      this.log("warn", "ACP agent spawn failed", { error: errorMessage(error) });
      throw error;
    }
    this.process = proc;
    this.generation = generation;
    proc.child.once("exit", (code, signal) => this.handleExit(code, signal, generation));
    // A framing failure (e.g. an oversized frame) errors the SDK connection
    // while the child can stay alive; a stdout close has the same effect. Run
    // the same teardown as a child exit so the runtime never sits on a dead
    // connection in "ready".
    proc.streamFailure.catch((error: Error) => this.handleStreamFailure(error, generation));

    const { connection, capabilities } = connectAcpClient(proc, {
      agentId: launch.agentId,
      fs: this.bridge.fs,
      onPermission: (request) => this.handlePermissionRequest(request, generation),
      onUpdate: (notification) => this.handleSessionUpdate(notification, generation),
    });
    this.connection = connection;

    try {
      const session = await performAcpHandshake(connection, {
        cwd: launch.cwd,
        capabilities,
        initializeMs: this.timeouts.initializeMs,
        newSessionMs: this.timeouts.newSessionMs,
        resumeSessionId: this.resume.target,
        race: (operation) => raceProcessFailures(this.process, operation),
        onInitialized: (init) => {
          this.authMethods = normalizeAuthMethods(init);
          if (this.authMethods.length > 0) this.bridge.onAuthMethods?.(this.authMethods);
        },
      });
      if (
        this.process !== proc ||
        this.currentState === "failed" ||
        this.currentState === "stopped"
      ) {
        // An exit or stream failure tore this generation down (the exit
        // event is not part of the failure race) while the session/new response
        // was in flight; never resurrect the dead session as "ready".
        throw new AcpAgentDiedError("Agent terminated during the handshake");
      }
      this.sessionId = session.sessionId;
      this.config.reset(session.config);
      this.resume.committed(session.sessionId, session.start);
      this.currentState = this.stopRequested ? "stopped" : "ready";
      this.log("info", "ACP agent session ready");
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
      if (!this.stopRequested) {
        this.log("warn", "ACP agent handshake failed", { error: errorMessage(failure) });
      }
      try {
        await this.terminateProcess(new AcpCancelledError("Handshake failed"));
      } catch (cleanupError) {
        // The handshake error stays authoritative; the cleanup failure is only reported.
        this.reportCleanupFailure(cleanupError);
      }
      throw failure;
    }
  }

  private handlePermissionRequest(
    request: RequestPermissionRequest,
    generation: number,
  ): Promise<RequestPermissionResponse> {
    return answerPermissionRequest(request, {
      generation,
      isLive: (sessionId) =>
        generation === this.generation &&
        this.currentState === "prompting" &&
        (sessionId === undefined || sessionId === this.sessionId),
      askBridge: this.bridge.requestPermission,
      pendingAsks: this.pendingAsks,
    });
  }

  private handleSessionUpdate(notification: SessionNotification, generation: number): void {
    // Only the current process and session surface. Buffered updates of a superseded process, updates of
    // other sessions (sub-agents, stale sessions) and history replayed by `session/load` are counted.
    const surfaced =
      generation === this.generation && notification.sessionId === this.sessionId
        ? this.config.surfaceUpdate(notification.update)
        : null;
    if (surfaced) this.emitEvent(surfaced);
    else this.ignoredUpdateCount += 1;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, generation: number): void {
    // A superseded process must not emit events or touch the current session.
    if (generation !== this.generation) return;
    this.emitEvent({ type: "process_exit", code, signal });
    cancelPendingAsks(this.pendingAsks);
    this.stallWatch.clear();
    if (this.stopRequested || this.currentState === "stopped") {
      this.log("info", "ACP agent process exited", { code, signal });
      return;
    }
    this.log("warn", "ACP agent process exited unexpectedly", { code, signal });
    this.currentState = "failed";
    this.exitedGeneration = generation;
    const died = new AcpAgentDiedError(
      `Agent process exited (code=${String(code)}, signal=${String(signal)})`,
    );
    this.activePrompt?.reject?.(died);
    void this.terminateProcess(died).catch((error: unknown) => this.reportCleanupFailure(error));
  }

  /** See `normalizeAcpPromptError`. */
  private normalizePromptError(error: unknown): Promise<unknown> {
    return normalizeAcpPromptError(error, {
      state: () => this.currentState,
      connectionAborted: () => this.connection?.signal.aborted === true,
      teardown: (reason) =>
        this.terminateProcess(reason).catch((cleanupError: unknown) =>
          this.reportCleanupFailure(cleanupError),
        ),
    });
  }

  /** Entry point for `streamFailure`: framing errors and stdout closes. */
  private handleStreamFailure(error: Error, generation: number): void {
    if (generation !== this.generation) return;
    if (this.stopRequested || this.currentState === "stopped") return;
    if (this.currentState === "failed") return;
    this.log("warn", "ACP agent stream failed", { error: error.message });
    void this.teardownAfterStreamFailure(error, generation).catch((cleanupError: unknown) =>
      this.reportCleanupFailure(cleanupError),
    );
  }

  private reportCleanupFailure(error: unknown): void {
    const message = errorMessage(error);
    this.log("error", "ACP agent process cleanup failed", { error: message });
    this.emitEvent({ type: "process_cleanup_failed", message });
  }

  private async teardownAfterStreamFailure(error: Error, generation: number): Promise<void> {
    if (error instanceof AcpStreamClosedError) {
      // A plain EOF usually means the child is dying: give the exit handler a
      // short window so a real death is still reported as `AcpAgentDiedError`.
      await waitUntil(() => this.currentState === "failed", DEATH_GRACE_MS);
      if (this.currentState === "failed" || this.currentState === "stopped") return;
    }
    // A restart may have created a new generation during the grace window.
    if (generation !== this.generation) return;
    await this.terminateProcess(error);
  }

  private armStallWatch(active: ActivePromptState): void {
    this.stallWatch.arm(active, () => this.activePrompt === active);
  }

  private terminateProcess(reason: Error): Promise<void> {
    if (this.termination) return this.termination;
    const owned = this.process;
    const pending = this.terminateOwnedProcess(reason)
      .catch((error: unknown) => {
        // Keep ownership so a later stop() can retry; an explicit stop stays terminal.
        this.process ??= owned;
        if (this.currentState !== "stopped") this.currentState = "failed";
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
    // Every teardown answers pending asks `cancelled` before rejecting the prompt.
    cancelPendingAsks(this.pendingAsks);
    this.stallWatch.clear();
    active?.reject?.(reason);
    // Snapshot the tree before closing the connection.
    const plan = proc ? await planAcpProcessTeardown(proc, this.timeouts) : undefined;
    try {
      this.connection?.close();
    } catch {
      // Closing an already-closed connection is fine.
    }
    this.connection = undefined;
    this.sessionId = undefined;
    if (!proc || !plan) return;
    const remainingPids = await runAcpProcessTeardown(proc, plan, this.timeouts);
    if (remainingPids.length > 0) {
      this.process = proc;
      if (this.currentState !== "stopped") this.currentState = "failed";
      throw new AcpStateError(`ACP process cleanup incomplete: ${remainingPids.join(", ")}`);
    }
  }

  private emitEvent(event: AcpRuntimeEvent): void {
    this.emit("event", event);
  }
}
