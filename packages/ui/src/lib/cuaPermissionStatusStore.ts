/** In-process shared cache for Computer Use Helper permission status. Two consumers need it: the Computer Use section in Settings and the always-visible input entry. Each previously maintained its own useCuaPermissionStatus instance, polling and storing sticky probe snapshots independently, so the same machine’s TCC grant could appear different in the two places and request volume doubled. This keeps the last result, in-flight deduplication, and sticky probe in one source of truth, partitioned by workspace. Refresh is event-driven rather than periodic (page entry, app regaining focus, explicit refresh) and is triggered by useCuaPermissionStatus. Cache survives component unmounts so returning to Settings immediately shows the last permission state instead of flashing from null/“unknown” to granted. */
import { isCuaPermissionStatusAvailable } from "@zcode/services";
import type {
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  ICuaPermissionService,
} from "@zcode/services";

import {
  persistCuaPermissionStatus,
  readCachedCuaPermissionStatus,
} from "./cuaPermissionStatusCache.js";

export interface CuaPermissionStatusSnapshot {
  /** Last successful query result; null means this workspace has never received a status. */
  status: CuaPermissionStatusResult | null;
  /** Whether status can be used for decisions. False during a query or after the latest query failed; the UI may keep displaying lastKnown, but actions such as “Open System Settings” must wait for a fresh result. */
  fresh: boolean;
  /** Whether there is any determined content to display. A cold cache hit is sufficient; once a real result has been seen, this only moves to true. The distinction from fresh: fresh says whether the current value was just confirmed and resets to false whenever a query starts. If display followed it, the permission button would alternate between “Open System Settings” and “Checking…” and keep changing width. Use settled only for display to prevent that jitter. */
  settled: boolean;
}

/** Snapshot returned when a workspace slot is missing. useSyncExternalStore requires getSnapshot to return a stable reference; constructing a new object on every call causes infinite rerenders, so construct it lazily once and reuse it. The initial value comes from the cross-process cache: an in-process slot is empty after restart, and starting from null would briefly render permission buttons in both Settings rows before hiding them on the first response, collapsing row height. TCC permission belongs to the Helper bundle, not a workspace, so this cache is the best current guess for any workspace; fresh=false indicates it has not been confirmed. */
let initialSnapshotCache: CuaPermissionStatusSnapshot | null = null;

function initialSnapshot(): CuaPermissionStatusSnapshot {
  if (!initialSnapshotCache) {
    const cached = readCachedCuaPermissionStatus();
    initialSnapshotCache = { status: cached, fresh: false, settled: cached !== null };
  }
  return initialSnapshotCache;
}

interface Slot {
  snapshot: CuaPermissionStatusSnapshot;
  inFlight: boolean;
  /** Another refresh requested during a query; coalesce it into one follow-up instead of running requests concurrently. */
  rerunRequested: boolean;
  /** An active screenshot is explicit user intent; merge only by OR, then reset immediately after consuming it so it runs at most once per cycle. */
  pendingFunctionalProbe: boolean;
  /** Retry timer for transient unavailability; undefined in a stable state. */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Number of retries already used, indexing TRANSIENT_RETRY_DELAYS_MS. */
  retryAttempt: number;
  /** Last known ready snapshot: once fully-ready is observed (both TCC grants plus both successful functional probes), keep the confirmed probe results through later read-only refreshes as long as both TCC grants remain. A read-only query does not run screenshot probes (upstream shouldRunCuaScreenCaptureProbe requires explicit includeFunctionalProbes), so publishing false would erase a readiness result already measured. Real degradation (TCC revoked / Helper unavailable) clears the sticky state in the else branch and publishes the new result. */
  stickyReady: CuaPermissionStatus | null;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

/** Same key structure as the Settings helperContextKey: permissions belong to (workspace path, workspace identity). Separate with NUL so spaces in paths cannot make different workspaces share a slot. */
export function cuaPermissionStatusKey(workspacePath: string, workspaceIdentity?: string): string {
  return [workspacePath, workspaceIdentity?.trim() ?? ""].join("\u0000");
}

export function subscribeCuaPermissionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCuaPermissionStatusSnapshot(key: string | null): CuaPermissionStatusSnapshot {
  if (!key) return initialSnapshot();
  return slots.get(key)?.snapshot ?? initialSnapshot();
}

/** Test reset: the module-level cache survives between cases. */
export function resetCuaPermissionStatusStoreForTest(): void {
  for (const slot of slots.values()) clearTransientRetry(slot);
  slots.clear();
  listeners.clear();
  initialSnapshotCache = null;
}

function ensureSlot(key: string): Slot {
  const existing = slots.get(key);
  if (existing) return existing;
  const created: Slot = {
    snapshot: initialSnapshot(),
    inFlight: false,
    rerunRequested: false,
    pendingFunctionalProbe: false,
    retryTimer: undefined,
    retryAttempt: 0,
    stickyReady: null,
  };
  slots.set(key, created);
  return created;
}

function clearTransientRetry(slot: Slot): void {
  if (slot.retryTimer) clearTimeout(slot.retryTimer);
  slot.retryTimer = undefined;
}

function publish(slot: Slot, snapshot: CuaPermissionStatusSnapshot): void {
  if (
    slot.snapshot.status === snapshot.status &&
    slot.snapshot.fresh === snapshot.fresh &&
    slot.snapshot.settled === snapshot.settled
  )
    return;
  slot.snapshot = snapshot;
  for (const listener of listeners) listener();
}

/** Display readiness means both TCC permissions are granted. Settings permission rows and the input entry share this definition so the same grant appears consistently. Do not use functional probes for display: a read-only refresh never runs screenshot probes (shouldRunCuaScreenCaptureProbe requires explicit includeFunctionalProbes, because screenshots must come from user intent), so screenCaptureProbeOk is always false and would mark every authorized user as needing authorization. True unavailability (TCC says granted but WindowServer does not provide pixels, etc.) is exposed to the model as a regular MCP tool error; the Renderer does not infer permissions from periodic queries or error text. */
export function isCuaPermissionTccGranted(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  );
}

/** End-to-end runtime readiness means both TCC permissions are granted and both functional probes succeed. It can be true only after an explicit active probe (after granting permission or validating after Helper restart), so it is used only to record the sticky snapshot below, not as the display criterion. */
function isFunctionallyReady(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.accessibilityProbeOk === true &&
    result.screenRecording === "granted" &&
    result.screenCaptureProbeOk === true
  );
}

/** Apply sticky probe results and return the value published externally. */
function withStickyProbes(
  slot: Slot,
  result: CuaPermissionStatusResult,
): CuaPermissionStatusResult {
  if (!("accessibility" in result)) {
    slot.stickyReady = null;
    return result;
  }
  if (isFunctionallyReady(result)) {
    slot.stickyReady = result;
    return result;
  }
  if (
    slot.stickyReady &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  ) {
    return {
      ...result,
      accessibilityProbeOk: slot.stickyReady.accessibilityProbeOk,
      screenCaptureProbeOk: slot.stickyReady.screenCaptureProbeOk,
    };
  }
  slot.stickyReady = null;
  return result;
}

/** Retry intervals (milliseconds) for transient unavailability. main-side getStatus honestly returns unavailable when the Helper host is not running (see packages/services/src/node.ts). Cold startup or recreation after enabling the plugin falls into this window; local measurements take about 3 seconds from installed to ready. Event-driven refresh samples only on mount/focus/explicit refresh, so treating this as terminal would leave the input entry with a red error dot and disabled, with no in-app recovery. The old polling loop recovered on the next sample; bounded backoff replaces it here. About 7 seconds total covers cold start; after retries, report the error accurately. No timers run in a stable state. */
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Schedule one retry; return false when the retry budget is exhausted so the caller can publish the result accurately. Do not pass options to retries: an active screenshot probe is explicit user intent and must not be amplified by automatic retries. */
function scheduleTransientRetry(slot: Slot, params: FetchCuaPermissionStatusParams): boolean {
  const delay = TRANSIENT_RETRY_DELAYS_MS[slot.retryAttempt];
  if (delay === undefined) {
    // Reset so the next real event (focus / refresh / remount) gets the full retry budget again.
    slot.retryAttempt = 0;
    return false;
  }
  slot.retryAttempt += 1;
  clearTransientRetry(slot);
  slot.retryTimer = setTimeout(() => {
    slot.retryTimer = undefined;
    const { service, workspacePath, workspaceIdentity } = params;
    fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity, mode: "retry" });
  }, delay);
  return true;
}

export interface FetchCuaPermissionStatusParams {
  service: ICuaPermissionService;
  workspacePath: string;
  workspaceIdentity?: string;
  options?: CuaPermissionStatusQueryOptions;
  /** “refresh” (default): external state may have just changed (focus return, Helper restart, plugin toggle), so an in-flight query may describe the old state and needs one follow-up. “ensure”: request a fresh result on mount; if a query is already running, join it, otherwise Settings and the input entry could each enqueue redundant host RPCs. “retry”: retry scheduled by the store; do not reset the counter, or every retry restores the full budget and bounded backoff becomes infinite fixed-interval polling. */
  mode?: "refresh" | "ensure" | "retry";
}

/** Query permission status and write to the shared cache. Concurrent calls for one workspace are coalesced: while one is running, remember at most one follow-up to avoid stacking accessibility + screenshot probes when focus fires repeatedly during native permission prompts or System Settings navigation. */
export function fetchCuaPermissionStatus(params: FetchCuaPermissionStatusParams): void {
  const { service, workspacePath, workspaceIdentity, options, mode = "refresh" } = params;
  const key = cuaPermissionStatusKey(workspacePath, workspaceIdentity);
  const slot = ensureSlot(key);
  slot.pendingFunctionalProbe ||= options?.includeFunctionalProbes === true;
  if (slot.inFlight) {
    if (mode === "refresh") slot.rerunRequested = true;
    return;
  }
  // A real event (mount / focus / explicit refresh) takes over sampling: cancel a queued retry and reset the budget.
  // A retry does not go through this path; otherwise each retry restores the full budget and bounded backoff turns into infinite polling.
  if (mode !== "retry") {
    clearTransientRetry(slot);
    slot.retryAttempt = 0;
  }
  slot.inFlight = true;
  const includeFunctionalProbes = slot.pendingFunctionalProbe;
  slot.pendingFunctionalProbe = false;
  // During a query, the old result cannot be used for decisions: the user may just have changed permissions in System Settings or the Helper may be restarting.
  publish(slot, { status: slot.snapshot.status, fresh: false, settled: slot.snapshot.settled });

  let completed: CuaPermissionStatusResult | null = null;
  void Promise.resolve()
    .then(() => service.getStatus(workspacePath, workspaceIdentity, { includeFunctionalProbes }))
    .then((result) => {
      completed = result;
    })
    .catch(() => {
      // Keep showing lastKnown; the bounded retry below will reconcile it.
    })
    .finally(() => {
      slot.inFlight = false;
      if (slot.rerunRequested) {
        // A refresh requested during a query means the old result may come from before the Helper restart; do not publish it, and run one follow-up query.
        slot.rerunRequested = false;
        fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity });
        return;
      }
      // Query failure or a Helper that is not running is an environmental transient, not a terminal permission result. While retry budget remains, keep the previous state
      // (fresh=false indicates it is unconfirmed) and let the retry converge.
      //
      // Once the retry budget is exhausted, the two branches end differently; spell them out here:
      // - unavailable (the Helper really cannot start) is published below and the UI shows an error.
      // - a rejected query (RPC channel failure) reaches `if (!completed)`: keep lastKnown + fresh=false,
      //   but do not create a terminal error. With no cold-start cache, the entry stays at starting and Settings at “Checking…”
      //   until the next real event (focus / remount / explicit refresh) samples again. This is intentional: a channel failure
      //   means “we do not know permission status,” not “there is a permission problem.” Showing it in red would mislead the user into
      //   re-authorizing. The tradeoff is no visible error message during this failure unless RPC continues failing.
      const transient = !completed || !isCuaPermissionStatusAvailable(completed);
      if (transient && scheduleTransientRetry(slot, params)) {
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      if (!completed) {
        // Rejected query after exhausting retries: keep lastKnown + fresh=false until the next real event (see above).
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      slot.retryAttempt = 0;
      const published = withStickyProbes(slot, completed);
      publish(slot, { status: published, fresh: true, settled: true });
      // Persist for the next cold-start first frame. persist ignores unavailable internally: a missing Helper is environmental state,
      // and remembering it would make the next cold-start view stale for longer.
      persistCuaPermissionStatus(published);
    });
}
