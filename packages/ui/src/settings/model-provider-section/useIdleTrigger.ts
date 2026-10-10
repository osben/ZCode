import { useCallback, useEffect, useRef, useState } from "react";

const MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS = 1_200;

/**
 * Shared "run after input stops" scheduler for Provider text saves and Model Config Resolution.
 * New input replaces only a timer that has not run yet; blur/Enter/save flushes and runs the same action immediately.
 */
export function useIdleTrigger<TResult>(
  action: () => TResult | Promise<TResult>,
  delayMs = MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS,
) {
  const actionRef = useRef(action);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scheduled, setScheduled] = useState(false);
  actionRef.current = action;

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setScheduled(false);
  }, []);

  const flush = useCallback(async (): Promise<TResult> => {
    cancel();
    return actionRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setScheduled(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setScheduled(false);
      // The owning form explicitly surfaces an idle-action failure on the next blur/save; the timer itself must not create
      // an unhandled rejection, or one resolution failure will pollute the entire Renderer debugging chain.
      try {
        void Promise.resolve(actionRef.current()).catch(() => undefined);
      } catch {
        // Synchronous failures are also surfaced by the owning form during an explicit flush.
      }
    }, delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return { cancel, flush, schedule, scheduled } as const;
}
