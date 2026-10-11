/**
 * The protocol process has one diagnostic output. Listen for asynchronous errors on the
 * actual stream, not only write failures; otherwise EPIPE -> uncaughtException -> another
 * stderr write can create a high-CPU feedback loop.
 */
export function installProtocolStderrBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalWrite = stderr.write;
  let unavailable = false;
  const onError = () => {
    unavailable = true;
  };
  stderr.on("error", onError);
  stderr.on("close", onError);
  stderr.write = ((chunk, encodingOrCallback, callback): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!unavailable) {
      try {
        return originalWrite.call(stderr, chunk, encoding, (error) => {
          if (error) unavailable = true;
          writeCallback?.();
        });
      } catch {
        unavailable = true;
      }
    }
    // Diagnostics are best-effort; if the output is unavailable, still complete the caller's flush without writing to the broken stream or reporting that failure.
    if (writeCallback) queueMicrotask(() => writeCallback());
    return true;
  }) as typeof stderr.write;
  return () => {
    stderr.write = originalWrite;
    stderr.off("error", onError);
    stderr.off("close", onError);
  };
}
