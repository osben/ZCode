import { parseShortcutBinding } from "@zcode/shared";

const MODIFIER_RELEASE_KEYS: Readonly<Record<string, readonly string[]>> = {
  CmdOrCtrl: ["Meta", "Control"],
  Ctrl: ["Control"],
  Alt: ["Alt"],
  AltGr: ["AltGraph"],
  Shift: ["Shift"],
};

/**
 * 判断一次 keyup 是否松开了语音快捷键的一部分（主键或任一修饰键）。
 * push-to-talk 模式下，松开即结束录音。
 */
export function isVoiceShortcutReleased(
  event: Pick<KeyboardEvent, "key" | "code">,
  binding: string,
): boolean {
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return false;
  if (event.key.length === 1 && event.key.toLowerCase() === parsed.key) return true;
  if (event.code === `Key${parsed.key.toUpperCase()}` && /^[a-z]$/.test(parsed.key)) return true;
  // 命名主键（F5、Enter、ArrowUp…）不走字母 code 分支：它们 event.key.length > 1 且
  // 规范名与 event.key 完全一致，直接比较，否则按住修饰键松开主键无法结束 push-to-talk。
  if (event.key.length > 1 && event.key === parsed.key) return true;
  const modifierKeys = [
    parsed.cmdOrCtrl ? MODIFIER_RELEASE_KEYS.CmdOrCtrl : [],
    parsed.ctrl ? MODIFIER_RELEASE_KEYS.Ctrl : [],
    parsed.alt ? MODIFIER_RELEASE_KEYS.Alt : [],
    parsed.altGr ? MODIFIER_RELEASE_KEYS.AltGr : [],
    parsed.shift ? MODIFIER_RELEASE_KEYS.Shift : [],
  ].flat();
  return modifierKeys.includes(event.key);
}
