/**
 * Worker-scoped owner of resident ACP agent processes (specs/acp-agent-runtime.md "Chat
 * delegation (phase 4)"): one AcpSessionRuntime per ZCode session.
 *
 * The runtime spawns on the session's first external turn and is reused by later turns. It stops on
 * session deactivation (`stopSession`), on worker shutdown (`stopAll`), and when the launch config
 * changes. A failed runtime is restarted explicitly before its next prompt.
 */
import { createHash } from "node:crypto";
import type { Logger } from "@zcode/contracts";
import {
  AcpSessionRuntime,
  type AcpHostBridge,
  type AcpLaunchOptions,
  type AcpPermissionAnswer,
  type AcpPermissionAsk,
  type AcpRuntimeEvent,
  type AcpRuntimeLogger,
  type AcpRuntimeState,
  type AcpSessionRuntimeOptions,
  type AcpSessionStart,
  type ContentBlock,
} from "@zcode/acp-agent-runtime";

/**
 * The part of a runtime the pool and turn driver use. Structural so tests can inject a fake;
 * `AcpSessionRuntime` satisfies it.
 */
export interface AcpPoolRuntime {
  readonly state: AcpRuntimeState;
  /** ACP session id of the runtime's current session. */
  readonly acpSessionId?: string;
  /** How the latest session began; read once per acquire (see `AcpSessionStart`). */
  takeSessionStart?(): AcpSessionStart | undefined;
  restart(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  prompt(
    text: string,
    blocks?: readonly ContentBlock[],
  ): Promise<{ readonly stopReason: string; readonly usage?: unknown }>;
  on(event: "event", listener: (event: AcpRuntimeEvent) => void): unknown;
  off(event: "event", listener: (event: AcpRuntimeEvent) => void): unknown;
}

export type AcpRuntimeFactory = (
  options: AcpSessionRuntimeOptions,
  bridge: AcpHostBridge,
) => Promise<AcpPoolRuntime>;

/** Answers one permission ask of the turn currently bound to a session. */
export type AcpTurnPermissionHandler = (ask: AcpPermissionAsk) => Promise<AcpPermissionAnswer>;

/** The ACP session a ZCode session resumes: agent, working directory and launch-config digest must match. */
export interface AcpSessionBinding {
  readonly agentId: string;
  readonly acpSessionId: string;
  readonly cwd: string;
  readonly launchKey: string;
}

/** Persistence of bindings (fork_acp_session_binding). Optional: without it every cold start is new. */
export interface AcpSessionBindings {
  read(sessionId: string): Promise<AcpSessionBinding | undefined>;
  write(sessionId: string, binding: AcpSessionBinding): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/** Digest of the launch config. The env can carry credentials, so the config itself is never stored. */
export function acpLaunchKey(launch: AcpLaunchOptions): string {
  return createHash("sha256").update(acpLaunchFingerprint(launch)).digest("hex");
}

export interface AcpSessionPoolOptions {
  readonly logger?: AcpRuntimeLogger;
  readonly bindings?: AcpSessionBindings;
  /**
   * Builds the host bridge of one runtime. Defaults to routing each ask to the turn bound to its
   * session (see `bindTurnPermission`); with no bound turn the ask is answered `cancelled`.
   */
  readonly bridgeFor?: (agentId: string, sessionId: string) => AcpHostBridge;
  readonly createRuntime?: AcpRuntimeFactory;
}

interface PoolEntry {
  readonly fingerprint: string;
  readonly runtime: AcpPoolRuntime;
}

/** Adapts the worker logger to the runtime's structural logger (fields carry ids and states only). */
export function acpRuntimeLoggerFrom(logger: Logger): AcpRuntimeLogger {
  return {
    info: (message, fields) => logger.info(message, fields),
    warn: (message, fields) => logger.warn(message, fields),
    error: (message, fields) => logger.error(message, undefined, fields),
  };
}

const defaultRuntimeFactory: AcpRuntimeFactory = (options, bridge) =>
  AcpSessionRuntime.start(options, bridge);

/** Identity of a launch: a change means the resident process no longer matches the record. */
export function acpLaunchFingerprint(launch: AcpLaunchOptions): string {
  const env = Object.entries(launch.env ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify({
    agentId: launch.agentId,
    command: launch.command,
    args: [...launch.args],
    env,
    cwd: launch.cwd,
  });
}

export class AcpSessionPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #turnPermissions = new Map<string, AcpTurnPermissionHandler>();
  readonly #bindings: AcpSessionBindings | undefined;
  readonly #createRuntime: AcpRuntimeFactory;
  readonly #bridgeFor: (agentId: string, sessionId: string) => AcpHostBridge;
  readonly #logger: AcpRuntimeLogger | undefined;

  constructor(options: AcpSessionPoolOptions = {}) {
    this.#logger = options.logger;
    this.#bindings = options.bindings;
    this.#createRuntime = options.createRuntime ?? defaultRuntimeFactory;
    this.#bridgeFor =
      options.bridgeFor ??
      ((agentId, sessionId) => ({
        requestPermission: (ask) => this.#answerAsk(agentId, sessionId, ask),
      }));
  }

  /**
   * Binds the permission handler of the turn that is running on `sessionId`. The runtime's asks for
   * that session go to the handler only while it is bound; the returned function unbinds it.
   */
  bindTurnPermission(sessionId: string, handler: AcpTurnPermissionHandler): () => void {
    this.#turnPermissions.set(sessionId, handler);
    return () => {
      if (this.#turnPermissions.get(sessionId) === handler) this.#turnPermissions.delete(sessionId);
    };
  }

  async #answerAsk(
    agentId: string,
    sessionId: string,
    ask: AcpPermissionAsk,
  ): Promise<AcpPermissionAnswer> {
    const handler = this.#turnPermissions.get(sessionId);
    if (handler === undefined) {
      // A live runtime can ask outside a bound turn only through a host bug; never allow implicitly.
      this.#logger?.info("ACP permission request cancelled (no turn bound to the session)", {
        agentId,
      });
      return { outcome: "cancelled" };
    }
    return handler(ask);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Returns the session's runtime for `launch`, spawning or restarting it as needed. */
  acquire(sessionId: string, launch: AcpLaunchOptions): Promise<AcpPoolRuntime> {
    return this.#serialize(sessionId, async () => {
      const fingerprint = acpLaunchFingerprint(launch);
      const existing = this.#entries.get(sessionId);
      if (existing && existing.fingerprint === fingerprint && existing.runtime.state !== "stopped") {
        if (existing.runtime.state === "failed") await existing.runtime.restart();
        await this.#recordBinding(sessionId, launch, existing.runtime);
        return existing.runtime;
      }
      if (existing) {
        this.#entries.delete(sessionId);
        await existing.runtime.stop();
      }
      const resume = await this.#resumeSessionId(sessionId, launch);
      const runtime = await this.#createRuntime(
        {
          agentId: launch.agentId,
          command: launch.command,
          args: [...launch.args],
          cwd: launch.cwd,
          ...(launch.env === undefined ? {} : { env: { ...launch.env } }),
          ...(this.#logger === undefined ? {} : { logger: this.#logger }),
          ...(resume === undefined ? {} : { resumeSessionId: resume }),
        },
        this.#bridgeFor(launch.agentId, sessionId),
      );
      this.#entries.set(sessionId, { fingerprint, runtime });
      await this.#recordBinding(sessionId, launch, runtime);
      return runtime;
    });
  }

  /**
   * The ACP session to load for a cold start: only a binding of the same agent, working directory and
   * launch config. Any other binding is cleared, so the agent starts a new session.
   */
  async #resumeSessionId(sessionId: string, launch: AcpLaunchOptions): Promise<string | undefined> {
    const stored = await this.#bindings?.read(sessionId);
    if (stored === undefined) return undefined;
    if (
      stored.agentId === launch.agentId &&
      stored.cwd === launch.cwd &&
      stored.launchKey === acpLaunchKey(launch)
    ) {
      return stored.acpSessionId;
    }
    await this.#bindings?.clear(sessionId);
    return undefined;
  }

  /** Records the session the runtime now holds, so the next cold start can load it. */
  async #recordBinding(sessionId: string, launch: AcpLaunchOptions, runtime: AcpPoolRuntime) {
    const acpSessionId = runtime.acpSessionId;
    if (this.#bindings === undefined || acpSessionId === undefined) return;
    await this.#bindings.write(sessionId, {
      agentId: launch.agentId,
      acpSessionId,
      cwd: launch.cwd,
      launchKey: acpLaunchKey(launch),
    });
  }

  /** Stops the session's agent process, if any. Safe to call repeatedly. */
  stopSession(sessionId: string): Promise<void> {
    return this.#serialize(sessionId, async () => {
      const entry = this.#entries.get(sessionId);
      if (!entry) return;
      this.#entries.delete(sessionId);
      await entry.runtime.stop();
    });
  }

  /** Worker shutdown: stop every resident agent. Failures are collected, not thrown midway. */
  async stopAll(): Promise<void> {
    const sessionIds = [...this.#entries.keys()];
    const results = await Promise.allSettled(sessionIds.map((id) => this.stopSession(id)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  #serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(sessionId, settled);
    void settled.then(() => {
      if (this.#chains.get(sessionId) === settled) this.#chains.delete(sessionId);
    });
    return next;
  }
}
