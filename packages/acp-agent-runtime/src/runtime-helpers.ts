/**
 * Internal helpers shared by the runtime: timeout defaults, deferred
 * promises, bounded timers and auth-method normalization.
 */
import { MessageTooLargeError, type InitializeResponse } from "@agentclientprotocol/sdk";
import { AcpTimeoutError } from "./errors.js";
import type { AcpAuthMethod, AcpPermissionAnswer, AcpRuntimeLogger, AcpTimeouts } from "./types.js";

export const DEFAULT_TIMEOUTS: Required<AcpTimeouts> = {
  initializeMs: 30_000,
  newSessionMs: 30_000,
  cancelGraceMs: 10_000,
  stopGraceMs: 2_000,
  killGraceMs: 5_000,
  stallWarningMs: 120_000,
};

export const CANCELLED_ANSWER: AcpPermissionAnswer = { outcome: "cancelled" };

/** How long a closed stream/connection waits for the child's exit event
 * before the failure is classified as a dead connection with a live child. */
export const DEATH_GRACE_MS = 1_000;

/** Runtime-owned state of the one active prompt. */
export interface ActivePromptState {
  readonly generation: number;
  stallEmitted: boolean;
  /** Set with the one `resumed` event that follows the prompt's stall. */
  resumedEmitted?: boolean;
  reject?: (reason?: unknown) => void;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AcpTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves `true` when the operation settles before `ms`, `false` otherwise. */
export function raceTimeout(operation: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  return Promise.race([
    operation.then(
      () => true,
      () => true,
    ),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Resolves `true` when the operation fulfills before `ms`; `false` on rejection or timeout. */
export function fulfillsWithin(operation: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    operation.then(
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
}

/** Polls `condition` until it holds or `ms` elapses; resolves whether it held. */
export async function waitUntil(
  condition: () => boolean,
  ms: number,
  stepMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(Math.min(stepMs, Math.max(1, deadline - Date.now())));
  }
  return condition();
}

/**
 * One stall warning per prompt: `arm` (re)starts the silence window on every
 * inbound activity; the warning fires once when the window elapses while the
 * prompt is still current. The first activity after the warning reports the
 * prompt resumed, once.
 */
export class StallWatch {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly silentMs: number,
    private readonly onStall: (silentMs: number) => void,
    private readonly onResume: () => void = () => {},
  ) {}

  arm(
    prompt: { stallEmitted: boolean; resumedEmitted?: boolean } | undefined,
    isCurrent: () => boolean,
  ): void {
    this.clear();
    if (prompt?.stallEmitted && !prompt.resumedEmitted && isCurrent()) {
      prompt.resumedEmitted = true;
      this.onResume();
    }
    if (!prompt || prompt.stallEmitted || this.silentMs <= 0) return;
    this.timer = setTimeout(() => {
      if (!isCurrent() || prompt.stallEmitted) return;
      prompt.stallEmitted = true;
      this.onStall(this.silentMs);
    }, this.silentMs);
    this.timer.unref?.();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Logger call that tags every entry with the agent id and swallows logger exceptions. */
export function createRuntimeLog(logger: AcpRuntimeLogger | undefined, agentId: string) {
  return (
    level: "info" | "warn" | "error",
    message: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void => {
    try {
      logger?.[level](message, { agentId, ...fields });
    } catch {
      // A faulty logger must never affect the lifecycle.
    }
  };
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function normalizeAuthMethods(init: InitializeResponse): readonly AcpAuthMethod[] {
  const raw = init.authMethods;
  if (!Array.isArray(raw)) return [];
  const methods: AcpAuthMethod[] = [];
  for (const method of raw) {
    if (!method || typeof method.id !== "string" || typeof method.name !== "string") continue;
    methods.push({
      id: method.id,
      name: method.name,
      description: method.description ?? null,
    });
  }
  return methods;
}

/**
 * The SDK v1 connection rejects pending requests with a plain "ACP connection
 * closed" error; the v2 surface uses `ConnectionClosedError` (not exported
 * from the main entry), so match it by name too.
 */
export function isConnectionClosedError(error: Error): boolean {
  return /connection closed/i.test(error.message) || error.name === "ConnectionClosedError";
}

/** Fatal transport failures of a prompt: an oversized frame or a closed connection. */
export function classifyTransportFailure(error: unknown): "framing" | "closed" | null {
  if (error instanceof MessageTooLargeError) return "framing";
  if (error instanceof Error && isConnectionClosedError(error)) return "closed";
  return null;
}
