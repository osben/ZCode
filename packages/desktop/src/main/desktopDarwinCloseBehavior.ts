interface DarwinCloseAwareWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
}

export function handleDarwinWindowCloseRequest(options: {
  win: DarwinCloseAwareWindow;
  forceQuit: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
}): boolean {
  if (options.forceQuit) {
    return false;
  }

  if (options.win.isFullScreen()) {
    // Native macOS fullscreen uses a separate Space; this previously kept the "click the red button = hide window" behavior.
    // Calling hide() in fullscreen hides the window in the fullscreen Space, leaving the user with a black screen even though the window did not actually close.
    // Exit fullscreen first so clicking close in fullscreen returns to a normal window and does not leave a black Space behind.
    options.win.setFullScreen(false);
    options.logger.info(
      `[createWindow] fullscreen close converted to leave-full-screen (${options.label})`,
    );
    return true;
  }

  options.win.hide();
  options.logger.info(`[createWindow] window hidden instead of closed (${options.label})`);
  return true;
}
