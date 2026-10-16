/**
 * AcpSessionRuntime — lifecycle owner for one external ACP agent process.
 *
 * Flow: spawn → initialize (protocol version check) → session/new → ready.
 * `prompt()` streams `session/update` events through `on("event", ...)` and
 * resolves when the turn stops. One active prompt per session; `cancel()` is
 * a bounded `session/cancel` with kill escalation; unexpected process death
 * moves the runtime to `failed` and the next `prompt()` restarts it.
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
} from "@agentclientprotocol/sdk";
import {
  AcpAgentDiedError,
  AcpCancelledError,
  AcpProtocolVersionError,
  AcpRuntimeError,
  AcpStateError,
} from "./errors.js";
import { readTextFileViaBridge, writeTextFileViaBridge } from "./fs.js";
import { buildChildEnv, validateLaunchOptions } from "./launch.js";
import { buildPermissionAsk, toPermissionResponse } from "./permissions.js";
import { signalProcessTree, spawnAcpProcess, type SpawnedAcpProcess } from "./transport.js";
import { mapSessionUpdate } from "./updates.js";
import {
  CANCELLED_ANSWER,
  DEFAULT_TIMEOUTS,
  createDeferred,
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

export interface AcpSessionRuntimeOptions extends AcpLaunchOptions {
  readonly timeouts?: AcpTimeouts;
  readonly maxFrameBytes?: number;
  /**
   * Receives every raw NDJSON frame in both directions (handshake, prompts,
   * cancels). Intended for diagnostics/UI debug panels; observer exceptions
   * are swallowed. `text` may be truncated for oversized lines.
   */
  readonly onFrame?: AcpFrameObserver;
}

interface ActivePromptState {
  readonly generation: number;
  stallEmitted: boolean;
  reject?: (reason?: unknown) => void;
}

export class AcpSessionRuntime extends EventEmitter {
  private readonly options: AcpSessionRuntimeOptions;
  private readonly bridge: AcpHostBridge;
  private readonly timeouts: Required<AcpTimeouts>;
  private process: SpawnedAcpProcess | undefined;
  private connection: ClientConnection | undefined;
  private sessionId: string | undefined;
  private authMethods: readonly AcpAuthMethod[] = [];
  private configOptions: unknown = null;
  private generation = 0;
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
    if (!connection || !sessionId || !this.activePrompt) return;
    await connection.agent.notify(methods.agent.session.cancel, { sessionId });
    const settled = await this.waitForPromptSettle(this.timeouts.cancelGraceMs);
    if (!settled) {
      await this.terminateProcess(new AcpCancelledError("Prompt did not settle after cancel"));
    }
  }

  /** Gracefully stops the runtime; safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.currentState === "stopped") return;
    this.stopRequested = true;
    this.currentState = "stopped";
    this.resolvePendingAsks(CANCELLED_ANSWER);
    this.clearStallTimer();
    await this.terminateProcess(new AcpCancelledError("Runtime stopped"));
  }

  /** Re-launches the agent and a fresh session after an unexpected death. */
  async restart(): Promise<void> {
    if (this.currentState !== "failed") return;
    this.stopRequested = false;
    this.currentState = "starting";
    await this.connect();
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
    proc.child.once("exit", (code, signal) => this.handleExit(code, signal));

    const app = createClientApp({ name: `zcode-acp-agent-runtime (${launch.agentId})` })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.handlePermissionRequest(ctx.params),
      )
      .onNotification(methods.client.session.update, (ctx) => this.handleSessionUpdate(ctx.params));
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
      this.sessionId = session.sessionId;
      this.configOptions =
        (session as unknown as { configOptions?: unknown }).configOptions ?? null;
      this.currentState = this.stopRequested ? "stopped" : "ready";
    } catch (error) {
      this.currentState = this.stopRequested ? "stopped" : "failed";
      await this.terminateProcess(new AcpCancelledError("Handshake failed"));
      throw error;
    }
  }

  private raceSpawn<T>(operation: Promise<T>): Promise<T> {
    const failure = this.process?.spawnFailure;
    return failure ? Promise.race([operation, failure]) : operation;
  }

  private assertProtocolVersion(init: InitializeResponse): void {
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpProtocolVersionError(PROTOCOL_VERSION, init.protocolVersion);
    }
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const generation = this.generation;
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
      if (this.generation !== generation) {
        // The runtime restarted while the host was deciding; never apply a
        // stale decision to the new session.
        return toPermissionResponse(request, CANCELLED_ANSWER);
      }
      return toPermissionResponse(request, answer);
    } finally {
      this.pendingAsks.delete(requestId);
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
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

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emitEvent({ type: "process_exit", code, signal });
    this.resolvePendingAsks(CANCELLED_ANSWER);
    this.clearStallTimer();
    if (this.stopRequested || this.currentState === "stopped") return;
    this.currentState = "failed";
    this.activePrompt?.reject?.(
      new AcpAgentDiedError(
        `Agent process exited (code=${String(code)}, signal=${String(signal)})`,
      ),
    );
  }

  /**
   * Normalizes "connection closed" rejections into `AcpAgentDiedError` when
   * the process actually died; intentional stops keep the original error.
   */
  private async normalizePromptError(error: unknown): Promise<unknown> {
    if (error instanceof AcpRuntimeError) return error;
    if (this.currentState === "stopped") return error;
    if (error instanceof Error && /connection closed/i.test(error.message)) {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && this.currentState !== "failed") {
        await sleep(10);
      }
      if (this.currentState === "failed") {
        return new AcpAgentDiedError("Agent process died during the prompt", { cause: error });
      }
    }
    return error;
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

  private async waitForPromptSettle(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.activePrompt) return true;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return this.activePrompt === undefined;
  }

  private async terminateProcess(reason: Error): Promise<void> {
    const proc = this.process;
    this.process = undefined;
    const active = this.activePrompt;
    this.activePrompt = undefined;
    active?.reject?.(reason);
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
    const exitedEarly = await raceTimeout(proc.exited, this.timeouts.stopGraceMs);
    if (exitedEarly) return;
    signalProcessTree(proc.child, "SIGTERM");
    const exitedAfterTerm = await raceTimeout(proc.exited, this.timeouts.killGraceMs);
    if (exitedAfterTerm) return;
    signalProcessTree(proc.child, "SIGKILL");
    await proc.exited.catch(() => {});
  }

  private emitEvent(event: AcpRuntimeEvent): void {
    this.emit("event", event);
  }
}
