/**
 * Local cache for CUA permission status.
 *
 * Why this is needed: `useCuaPermissionStatus` starts with a null status, while the detail buttons on the two permission rows in Settings
 * are hidden only when `=== "granted"`, so while status is null both rows render “Open Accessibility /
 * Open Screen Recording” buttons. When the first query returns (the actual result is granted), both buttons disappear and the row height collapses —
 * users see a layout jump every time they open Settings. The persistent input entry has the same issue: it starts at starting and then jumps to ready.
 *
 * The cache retains the previous real result for the next launch as an optimistic initial value, so in the common case (permission has not changed)
 * the first screen is already in its final state and does not jump.
 *
 * Boundary (important): cached values here are **for rendering only** and never participate in permission decisions.
 * - Display follows `settled` (true as soon as there is content to show), so when the cache hits, the Settings “Open System Settings” button
 *   is **immediately clickable** without waiting for the real result — this is intentional; otherwise the button label would jump between “Checking…” and
 *   the final state. Safety does not rely on disabling this button; it is enforced at the click boundary:
 *   `openPermissionSettings` calls `getStatus` again and uses `requiredCuaPermissionsForFreshStatus`
 *   for precise validation; a stale value cannot open the wrong system panel and instead shows a toast and triggers a refresh.
 * - `fresh` is still set to true only when the real result arrives, for decision-making checks.
 * - The actual feature gate is in the Helper/producer; failures reach the model as regular MCP tool errors,
 *   independent of this cache, and the Renderer does not trigger permission side effects automatically.
 * Thus, the worst case is briefly showing a state of unknown accuracy on the first screen before the next event-driven query replaces it.
 */
import {
  isCuaPermissionStatusAvailable,
  type CuaPermissionState,
  type CuaPermissionStatus,
  type CuaPermissionStatusResult,
} from "@zcode/services";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** TCC permission is scoped to the app (Helper bundle), not the workspace, so use one global key rather than one per workspace. */
const CUA_PERMISSION_STATUS_CACHE_KEY = "zcode-cua-permission-status";

/**
 * Cache lifetime. Users may change permissions in System Settings while ZCode is not running, so older cache entries are less trustworthy;
 * after expiration, return to the cold-start state (null) rather than render the first screen from a grant that may have been revoked.
 */
const CUA_PERMISSION_STATUS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PERMISSION_STATES: readonly CuaPermissionState[] = ["granted", "stale", "denied", "unknown"];

interface CachedEnvelope {
  savedAt: number;
  status: CuaPermissionStatus;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPermissionState(value: unknown): value is CuaPermissionState {
  return PERMISSION_STATES.includes(value as CuaPermissionState);
}

/**
 * Validate every field. The cache survives version changes, so a field change (rename/type change) could feed undefined into
 * a rendering branch and cause a harder-to-diagnose issue than a layout jump; treat it as invalid and return null instead.
 */
function parseCachedStatus(value: unknown): CuaPermissionStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.grantOwner !== "string" ||
    !isPermissionState(candidate.accessibility) ||
    !isPermissionState(candidate.screenRecording) ||
    typeof candidate.accessibilityProbeOk !== "boolean" ||
    typeof candidate.screenCaptureProbeOk !== "boolean"
  ) {
    return null;
  }
  if (
    candidate.grantOwnerDisplayName !== undefined &&
    typeof candidate.grantOwnerDisplayName !== "string"
  ) {
    return null;
  }

  const parsed: CuaPermissionStatus = {
    grantOwner: candidate.grantOwner,
    accessibility: candidate.accessibility,
    accessibilityProbeOk: candidate.accessibilityProbeOk,
    screenRecording: candidate.screenRecording,
    screenCaptureProbeOk: candidate.screenCaptureProbeOk,
  };
  if (typeof candidate.grantOwnerDisplayName === "string") {
    parsed.grantOwnerDisplayName = candidate.grantOwnerDisplayName;
  }
  return parsed;
}

export function readCachedCuaPermissionStatus(
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): CuaPermissionStatus | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(CUA_PERMISSION_STATUS_CACHE_KEY) ?? null;
  } catch {
    // Private mode / disabled storage: treat as no cache.
    return null;
  }
  if (!raw) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;

  const { savedAt, status } = envelope as Partial<CachedEnvelope>;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  // A savedAt value in the future means the clock changed or was tampered with; freshness cannot be determined, so do not trust it.
  const age = now - savedAt;
  if (age < 0 || age > CUA_PERMISSION_STATUS_CACHE_TTL_MS) return null;

  return parseCachedStatus(status);
}

export function persistCuaPermissionStatus(
  status: CuaPermissionStatusResult,
  storage: StorageLike | null = getBrowserStorage(),
  now: number = Date.now(),
): void {
  // unavailable means the Helper is not running, the platform is not macOS, or this is not product mode; it is an environment state, not a permission state.
  // Persisting it would reproduce an incorrect initial screen next time, so do not write it (and do not clear an existing valid cache).
  if (!isCuaPermissionStatusAvailable(status)) return;

  const envelope: CachedEnvelope = { savedAt: now, status };
  try {
    storage?.setItem(CUA_PERMISSION_STATUS_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota full / private mode: the cache is only a first-screen optimization, so a failed write does not affect functionality.
  }
}
