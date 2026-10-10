// macOS permission status for Computer Use Helper. Status comes from the Helper’s current runtime preflight; historical TCC records are not used.
// See isCuaPermissionTccGranted in cuaPermissionStatusStore for the display rule.
//
// Refresh is no longer polled periodically; it is event-driven and queried once at these three times:
// - on mount (Settings page or input entry first renders);
// - when the window regains focus (after returning from macOS System Settings with a new grant);
// - when the caller explicitly refreshes (plugin toggle, Helper restart, or recovery after returning from authorization).
//
// Polling was removed because permissions change infrequently; second-level polling adds Host RPCs and keeps the UI jittering —
// every query sets fresh=false, making the Settings permission button alternate between “Open System Settings” and “Checking…”.
// Status lives in the in-process shared cache in lib/cuaPermissionStatusStore.
// Settings and the input entry read the same value, so returning to the page shows the last status rather than flashing from “unknown.”
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CuaPermissionStatusQueryOptions, CuaPermissionStatusResult } from "@zcode/services";
import {
  cuaPermissionStatusKey,
  fetchCuaPermissionStatus,
  getCuaPermissionStatusSnapshot,
  subscribeCuaPermissionStatus,
} from "@/lib/cuaPermissionStatusStore.js";
import { useOptionalServices } from "./useServices.js";

export function useCuaPermissionStatus(
  workspacePath: string | null,
  workspaceIdentity?: string,
): {
  status: CuaPermissionStatusResult | null;
  fresh: boolean;
  /** Stable display flag: true once there is content to show and does not reset on every query. See the store comment. */
  settled: boolean;
  refresh: (options?: CuaPermissionStatusQueryOptions) => void;
} {
  const services = useOptionalServices();
  // cuaPermissionService is optional in main (remote hosts have no CUA). When absent, do not query,
  // so the snapshot is always empty and callers display “unknown.”
  const cuaPermissionService = services?.cuaPermissionService;
  const key =
    workspacePath && cuaPermissionService
      ? cuaPermissionStatusKey(workspacePath, workspaceIdentity)
      : null;

  const snapshot = useSyncExternalStore(
    subscribeCuaPermissionStatus,
    useCallback(() => getCuaPermissionStatusSnapshot(key), [key]),
  );

  const query = useCallback(
    (mode: "refresh" | "ensure", options?: CuaPermissionStatusQueryOptions): void => {
      if (!workspacePath || !cuaPermissionService) return;
      fetchCuaPermissionStatus({
        service: cuaPermissionService,
        workspacePath,
        mode,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(options ? { options } : {}),
      });
    },
    [cuaPermissionService, workspaceIdentity, workspacePath],
  );

  const refresh = useCallback(
    (options?: CuaPermissionStatusQueryOptions): void => query("refresh", options),
    [query],
  );

  useEffect(() => {
    if (!workspacePath || !cuaPermissionService) return;
    // Query once on page entry. Settings and the input entry may mount consecutively; use ensure so the latter joins the former’s in-flight request.
    query("ensure");
    // After returning from macOS System Settings with a new grant, state may have changed and must be refreshed forcibly.
    const onFocus = (): void => query("refresh");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cuaPermissionService, query, workspacePath]);

  return {
    status: snapshot.status,
    fresh: snapshot.fresh,
    settled: snapshot.settled,
    refresh,
  };
}
