import { useEffect, useState } from "react";

/**
 * Reuse the 5-second operation deadline used by the browser-use tab cursor icon.
 * The icon and in-browser hint must share this check so one cannot show the tool as running while the other says it has finished.
 */
export function useBrowserUseOperationActive(operationUntil = 0): boolean {
  const [expiredOperationUntil, setExpiredOperationUntil] = useState(0);
  const isActive = operationUntil > Date.now() && expiredOperationUntil !== operationUntil;

  useEffect(() => {
    const remainingMs = operationUntil - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setExpiredOperationUntil(operationUntil), remainingMs);
    return () => window.clearTimeout(timer);
  }, [operationUntil]);

  return isActive;
}
