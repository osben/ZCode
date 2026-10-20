import { useEffect, useRef } from "react";

export const PULL_REQUEST_STATUS_POLL_INTERVAL_MS = 30_000;

export function usePullRequestStatusPolling(probe: () => void, active: boolean): void {
  const probeRef = useRef(probe);
  probeRef.current = probe;

  useEffect(() => {
    if (!active) {
      return;
    }
    const probeWhenVisible = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        probeRef.current();
      }
    };
    window.addEventListener("focus", probeWhenVisible);
    document.addEventListener("visibilitychange", probeWhenVisible);
    const interval = window.setInterval(probeWhenVisible, PULL_REQUEST_STATUS_POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", probeWhenVisible);
      document.removeEventListener("visibilitychange", probeWhenVisible);
      window.clearInterval(interval);
    };
  }, [active]);
}
