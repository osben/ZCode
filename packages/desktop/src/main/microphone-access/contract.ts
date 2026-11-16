/**
 * desktop-microphone-access module contract: everything a caller must know to use it correctly.
 * The renderer never imports this module — it reaches the same surface through the optional
 * IPlatformService microphone capabilities (preload bridge → PlatformChannels IPC).
 */

/**
 * Runs one macOS "re-authorize" attempt: an existing grant is never reset; without the tccutil
 * step (dev build) a restart is requested; a failed tccutil run reports failure without asking;
 * a fresh prompt maps its answer; a still-denied record requires a restart (TCC re-reads on next
 * launch). Always resolves — never rejects.
 */
export type ResolveMicrophoneReset = () => Promise<
  "granted" | "denied" | "restart-required" | "failed"
>;

export interface DesktopMicrophoneAccessContract {
  /**
   * Registers the four IPC handlers (status / ask / reset / open settings). Idempotent per
   * process lifetime; call once from the platform IPC bootstrap. Concurrent resets serialize on
   * one chain, so two windows never run tccutil or a system prompt simultaneously.
   */
  registerDesktopMicrophoneAccessIpc(options: {
    logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  }): void;
}
