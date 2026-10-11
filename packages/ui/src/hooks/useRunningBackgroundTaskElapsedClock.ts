import { useEffect, useState } from "react";

export function useRunningBackgroundTaskElapsedClock(runningTaskCount: number) {
  const [now, setNow] = useState(() => Date.now());
  const hasRunningTasks = runningTaskCount > 0;

  useEffect(() => {
    if (!hasRunningTasks) {
      return;
    }

    // Completing one task should not restart the whole timer group, or the remaining tasks' seconds will pause briefly and then jump.
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [hasRunningTasks]);

  return now;
}
