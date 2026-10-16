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
  // 手机触控设备关闭工具栏弹层后，如果继续把焦点送回 contenteditable，
  // 系统软键盘会再次弹出并遮挡远控界面；桌面端仍保留关闭后继续输入的键盘流。
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
