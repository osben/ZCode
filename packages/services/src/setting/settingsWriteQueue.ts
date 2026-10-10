const SETTINGS_WRITE_QUEUE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_QUEUE_TIMEOUT_ENV = "ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS";

function getSettingsWriteQueueTimeoutMs(): number {
  const rawValue = process.env[SETTINGS_WRITE_QUEUE_TIMEOUT_ENV]?.trim();
  if (!rawValue) {
    return SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
}

export function withSettingsWriteQueueTimeout(
  runUpdate: (enterCommitPhase: () => void) => Promise<void>,
  expireCurrentWrite: () => void,
): Promise<void> {
  const timeoutMs = getSettingsWriteQueueTimeoutMs();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let commitPhaseEntered = false;

  const clearQueueTimeout = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const enterCommitPhase = () => {
    commitPhaseEntered = true;
    clearQueueTimeout();
  };

  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (commitPhaseEntered) {
        return;
      }
      expireCurrentWrite();
      // The settings write queue owns the actual persistence order; not awaiting in the Provider layer cannot release this pending write.
      // Timeouts are allowed only before commit; once rename begins, wait for the critical section to finish so a late old write cannot overwrite new settings.
      reject(new Error(`settingService update timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  return Promise.race([runUpdate(enterCommitPhase), timeoutPromise]).finally(clearQueueTimeout);
}
