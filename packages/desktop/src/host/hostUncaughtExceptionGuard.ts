interface HostUncaughtExceptionGuardOptions {
  onRecovered: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
  onFatal: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

function isRecoverableHostAllocationError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === "Failed to allocate memory";
}

export function createHostUncaughtExceptionHandler({
  onRecovered,
  onFatal,
}: HostUncaughtExceptionGuardOptions): (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void {
  return (error, origin) => {
    if (!isRecoverableHostAllocationError(error)) {
      onFatal(error, origin);
      return;
    }

    try {
      // When Electron's bundled Node projects a peer certificate as a JS object during a TLS handshake,
      // a native Buffer allocation failure can escape the socket callback; Utility Process aborts by default.
      // The same allocation error in a regular Promise chain can be recovered through request timeout/retry, so isolate only this specific error here;
      // a logging failure must not be promoted to a process-level uncaught exception.
      onRecovered(error, origin);
    } catch {
      // Under memory pressure, diagnostic logging itself may fail to allocate; this guard must remain non-throwing.
    }
  };
}
