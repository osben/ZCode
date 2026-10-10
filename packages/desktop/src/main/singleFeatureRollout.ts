/**
 * Shared mechanism for single-feature rollouts: TTL cache, in-flight deduplication, 3-second request
 * timeout, and a bounded awaitFirstDecision. Callers inject feature-specific response parsing
 * (resolveConfig).
 *
 * This is shared because desktopContextPromptRollout and rendererActionTraceRollout use the same
 * side-channel request to /api/v1/client/configs and differ only in parsing `data.configs.<key>`.
 * Duplicating 170 lines of mechanism code could silently make timeout/TTL behavior diverge.
 *
 * Semantics (matching desktopContextPromptRollout and also used by fail-closed CUA rollouts):
 * - On request, timeout, or parse failure, keep the previous snapshot (on first-call failure, use the initial snapshot determined by defaultValue).
 * - If the server succeeds but omits the key, treat it as "not enabled" and replace the old cache; do not keep an older enabled snapshot.
 */
interface SingleFeatureRolloutConfig {
  enabled: boolean;
  configVersion?: string;
}

export interface SingleFeatureRollout<T extends SingleFeatureRolloutConfig> {
  refresh(): Promise<T>;
  getSnapshot(): T;
  /**
   * Wait for one rollout decision with a bound: race the server request and fall back to the current snapshot on timeout.
   *
   * Rationale: the Host/Agent presentation surface is frozen at process startup (`services/node.ts`
   * top-level const + CLI --surface), while the rollout request is a side channel that does not
   * block Host startup. If the first Host fork happens before the request resolves, the frozen
   * Host/Agent has no way to apply a successful result. This method gives successful results a
   * bounded path to take effect: the caller awaits it before the first Host fork, then the spawn
   * flow reads the snapshot synchronously. This method is stateless; the caller (desktop main) owns
   * the first-only latch.
   */
  awaitFirstDecision(timeoutMs: number): Promise<T>;
}

export interface SingleFeatureRolloutLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const SINGLE_FEATURE_REQUEST_TIMEOUT_MS = 3_000;
const SINGLE_FEATURE_CACHE_TTL_MS = 60 * 60 * 1_000;

interface CreateSingleFeatureRolloutOptions<T extends SingleFeatureRolloutConfig> {
  /** Parse the /api/v1/client/configs response body; null means invalid and is handled as a failure (keep the previous snapshot). */
  resolveConfig: (payload: unknown) => T | null;
  /** Initial snapshot (fail-open features pass {enabled:true}; fail-closed features pass {enabled:false}). */
  defaultValue: T;
  /** Log prefix, such as "desktop-context-prompt" / "renderer-action-trace". */
  logTag: string;
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  logger: SingleFeatureRolloutLogger;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export function createSingleFeatureRollout<T extends SingleFeatureRolloutConfig>(
  options: CreateSingleFeatureRolloutOptions<T>,
): SingleFeatureRollout<T> {
  let snapshot: T = options.defaultValue;
  let snapshotExpiresAt = 0;
  let inFlight: Promise<T> | undefined;
  const timeoutMs = Math.max(options.timeoutMs ?? SINGLE_FEATURE_REQUEST_TIMEOUT_MS, 1);
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? SINGLE_FEATURE_CACHE_TTL_MS, 1);

  const refresh = (): Promise<T> => {
    if (Date.now() < snapshotExpiresAt) {
      return Promise.resolve(snapshot);
    }
    if (inFlight) {
      return inFlight;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`${options.logTag} config timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        });
        const payload = await Promise.race([
          options.fetchConfig(controller.signal),
          timeoutPromise,
        ]);
        const next = options.resolveConfig(payload);
        if (!next) {
          throw new Error(`${options.logTag} config is invalid`);
        }
        snapshot = next;
        snapshotExpiresAt = Date.now() + cacheTtlMs;
        options.logger.info?.(`[${options.logTag}] config refreshed`, {
          enabled: next.enabled,
          configVersion: next.configVersion,
        });
        return snapshot;
      } catch (error) {
        // Rollout configuration is a side channel: server errors/timeouts must not block the client.
        // Keep a previous successful result, and fall back to the default on first failure.
        options.logger.warn(`[${options.logTag}] config unavailable, using cached decision`, {
          error,
          enabled: snapshot.enabled,
        });
        return snapshot;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        controller.abort();
      }
    })();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
    );
    return request;
  };

  return {
    refresh,
    getSnapshot: () => snapshot,
    awaitFirstDecision: (timeoutMs: number) => {
      // Race refresh(): it already handles TTL/in-flight deduplication and a 3-second request timeout,
      // and never rejects (on error it returns the previous snapshot). The outer timeout falls back
      // to the current snapshot. Both branches resolve so callers (the first Host fork path) are
      // never blocked by a rejection.
      const boundedTimeout = Math.max(timeoutMs, 1);
      const fallback = new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(snapshot), boundedTimeout);
        // A side-channel timer must not prevent process exit (tests/shutdown scenarios).
        timer.unref?.();
      });
      return Promise.race([refresh(), fallback]);
    },
  };
}
