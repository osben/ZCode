/**
 * Worker-scoped owner of resident ACP agent processes (specs/acp-agent-runtime.md "Chat
 * delegation (phase 4)"): one AcpSessionRuntime per ZCode session.
 *
 * The runtime spawns on the session's first external turn and is reused by later turns. It stops on
 * session deactivation (`stopSession`), on worker shutdown (`stopAll`), and when the launch config
 * changes. A failed runtime is restarted explicitly before its next prompt.
 */
import type { Logger } from "@zcode/contracts";
import {
  AcpSessionRuntime,
  type AcpHostBridge,
  type AcpLaunchOptions,
  type AcpRuntimeEvent,
  type AcpRuntimeLogger,
  type AcpRuntimeState,
  type AcpSessionRuntimeOptions,
  type ContentBlock,
} from "@zcode/acp-agent-runtime";

/**
 * The part of a runtime the pool and turn driver use. Structural so tests can inject a fake;
 * `AcpSessionRuntime` satisfies it.
 */
export interface AcpPoolRuntime {
  readonly state: AcpRuntimeState;
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

export interface AcpSessionPoolOptions {
  readonly logger?: AcpRuntimeLogger;
  /** Builds the host bridge of one agent; defaults to the S2 permission policy (cancel). */
  readonly bridgeFor?: (agentId: string) => AcpHostBridge;
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
  readonly #createRuntime: AcpRuntimeFactory;
  readonly #bridgeFor: (agentId: string) => AcpHostBridge;
  readonly #logger: AcpRuntimeLogger | undefined;

  constructor(options: AcpSessionPoolOptions = {}) {
    this.#logger = options.logger;
    this.#createRuntime = options.createRuntime ?? defaultRuntimeFactory;
    this.#bridgeFor =
      options.bridgeFor ??
      ((agentId) => ({
        // S2: permission asks are never surfaced; the runtime answers `cancelled`. S4 adds user-once.
        requestPermission: async () => {
          options.logger?.info("ACP permission request cancelled (not surfaced in this slice)", {
            agentId,
          });
          return { outcome: "cancelled" };
        },
      }));
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
        return existing.runtime;
      }
      if (existing) {
        this.#entries.delete(sessionId);
        await existing.runtime.stop();
      }
      const runtime = await this.#createRuntime(
        {
          agentId: launch.agentId,
          command: launch.command,
          args: [...launch.args],
          cwd: launch.cwd,
          ...(launch.env === undefined ? {} : { env: { ...launch.env } }),
          ...(this.#logger === undefined ? {} : { logger: this.#logger }),
        },
        this.#bridgeFor(launch.agentId),
      );
      this.#entries.set(sessionId, { fingerprint, runtime });
      return runtime;
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
