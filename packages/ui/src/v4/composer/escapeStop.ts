// Composer parity: pure function for deciding when Escape should not trigger Stop (no host dependency).
export function shouldIgnoreEscapeForStopGeneration(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true;
  }

  const path = event.composedPath();
  return path.some((target) => {
    if (!target || typeof target !== "object") {
      return false;
    }

    const maybeElement = target as {
      dataset?: { slot?: string };
      getAttribute?: (name: string) => string | null;
    };
    return (
      // When Escape closes the Cmd/Ctrl+P file picker, the same event continues bubbling
      // to the window. Detect the Radix/Dialog event path and skip stopping the task, preventing "close dialog" from accidentally stopping generation.
      maybeElement.dataset?.slot === "dialog-content" ||
      maybeElement.getAttribute?.("role") === "dialog"
    );
  });
}
