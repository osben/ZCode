interface ParentDisconnectSource {
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/**
 * Register a cleanup hook for Core when Supervisor IPC disconnects.
 *
 * If Supervisor is force-killed, it will not send a shutdown command; Core must still close its own
 * HTTP/WebSocket and Agent resources, or it may outlive the data-root lock as an orphan process.
 */
export function installParentDisconnectHandler(
  onDisconnect: () => void | Promise<void>,
  source: ParentDisconnectSource = process,
): () => void {
  const handler = (): void => {
    void onDisconnect();
  };
  source.once("disconnect", handler);
  return () => source.off("disconnect", handler);
}
