// Verify accessibility after restarting Helper: absorb tccd propagation lag and decide whether to escalate to the “restart ZCode” fallback.
//
// Background: after macOS Accessibility permission is granted, the running Helper's AXIsProcessTrusted is process-cached; Helper must be restarted
// (a new process) to pick it up. When restartHelper returns, the new Helper's broker socket is healthy, but AX state may still be stale
// (tccd propagation takes a few seconds). A single refresh may still read stale state and make users think the restart did not work.
//
// This helper polls accessibility after restart: any state other than stale (granted/denied/unknown) counts as “resolved” and returns false;
// return true only if state remains stale until timeout (or stays unavailable/throws), triggering the UI's “restart ZCode” fallback.
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";

interface WaitForAccessibilityNotStaleOptions {
  /** Total timeout (6s by default): covers tccd propagation lag; the first poll is usually granted immediately. */
  timeoutMs?: number;
  /** Poll interval (500ms by default). */
  intervalMs?: number;
}

type GetCuaPermissionStatusFn = () => Promise<CuaPermissionStatusResult>;

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll accessibility after restarting Helper to determine whether it has left the stale state.
 *
 * @returns `false` — accessibility left stale within the timeout (granted/denied/unknown); no escalation needed.
 *          `true` — it remained stale until timeout (or stayed unavailable/threw); escalate to the “restart ZCode” fallback.
 *
 * Semantics:
 *  - `granted` → restart picked up the permission; resolved.
 *  - `denied`/`unknown` → a real permission gap (user has not granted access), not a “restart failure”; do not escalate (the permission guide handles it).
 *  - Persistent `stale` → tccd cache did not refresh / restart mechanism is stuck → escalate.
 *  - unavailable / exception → transient state during restart; keep polling, and escalate if it has not recovered by timeout.
 */
export async function waitForAccessibilityNotStale(
  getStatus: GetCuaPermissionStatusFn,
  options: WaitForAccessibilityNotStaleOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const result = await getStatus();
      if (isCuaPermissionStatusAvailable(result) && result.accessibility !== "stale") {
        return false;
      }
    } catch {
      // getStatus may fail briefly during restart (socket switch / Helper just started). Treat it as unresolved and keep polling.
    }
    if (Date.now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
