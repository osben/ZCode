import { TID_V4_COMPOSER, TID_V4_COMPOSER_INPUT } from "@zcode/shared";

export function isCoarseTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function shouldRestoreChatInputFocusAfterPickerClose({
  isCoarseTouchDevice: coarseTouch,
}: {
  isCoarseTouchDevice: boolean;
}): boolean {
  // On mobile touch devices, returning focus to contenteditable after closing the toolbar popover
  // reopens the system keyboard and obscures the remote-control interface. Desktop keeps the keyboard flow for continued typing after close.
  return !coarseTouch;
}

export function restoreComposerInputFocusAfterPickerClose({
  anchor,
  fallbackSelector,
}: {
  anchor: Element | null;
  fallbackSelector?: string | null;
}): void {
  if (isCoarseTouchDevice()) return;

  const composer = anchor?.closest(`[data-testid="${TID_V4_COMPOSER}"]`);
  const input =
    composer?.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`) ??
    (fallbackSelector ? document.querySelector<HTMLElement>(fallbackSelector) : null);
  input?.focus();
}
