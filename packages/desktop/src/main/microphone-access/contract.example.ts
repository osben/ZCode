/**
 * desktop-microphone-access canonical call example: this is the shape agents should imitate.
 */
import { registerDesktopMicrophoneAccessIpc } from "./desktopMicrophoneAccess.js";

export function exampleDesktopMicrophoneAccess(): void {
  // Called once from the platform IPC bootstrap with the main-process logger.
  registerDesktopMicrophoneAccessIpc({
    logger: { info: console.log, warn: console.warn },
  });
}
