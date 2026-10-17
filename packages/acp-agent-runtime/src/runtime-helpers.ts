/**
 * Internal helpers shared by the runtime: timeout defaults, deferred
 * promises, bounded timers and auth-method normalization.
 */
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { AcpTimeoutError } from "./errors.js";
import type { AcpAuthMethod, AcpPermissionAnswer, AcpTimeouts } from "./types.js";

export const DEFAULT_TIMEOUTS: Required<AcpTimeouts> = {
  initializeMs: 30_000,
  newSessionMs: 30_000,
  cancelGraceMs: 10_000,
  stopGraceMs: 2_000,
  killGraceMs: 5_000,
  stallWarningMs: 120_000,
};

export const CANCELLED_ANSWER: AcpPermissionAnswer = { outcome: "cancelled" };

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
