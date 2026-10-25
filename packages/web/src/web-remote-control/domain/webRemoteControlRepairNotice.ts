/**
 * Shown when a phone opens a QR link from before the relay V2 migration. Those links carry the V1
 * `hash`/`t` credential, which V2 rejects, so the paired device must be re-paired from the desktop.
 * Only en-US and uk-UA are provided; other languages fall back to en-US.
 */
export const WEB_REMOTE_CONTROL_REPAIR_NOTICE = {
  "en-US":
    "This link is from an older ZCode version. Re-pair this phone: on your computer, open Web remote control, then scan the new QR code.",
  "uk-UA":
    "Це посилання з попередньої версії ZCode. Потрібно знову з'єднати телефон: на комп'ютері відкрийте віддалене керування через Web і відскануйте новий QR-код.",
} as const;

export type WebRemoteControlRepairNoticeLocale = keyof typeof WEB_REMOTE_CONTROL_REPAIR_NOTICE;

export function resolveWebRemoteControlRepairNotice(language: string | undefined): string {
  const locale: WebRemoteControlRepairNoticeLocale = /^uk\b/i.test(language ?? "")
    ? "uk-UA"
    : "en-US";
  return WEB_REMOTE_CONTROL_REPAIR_NOTICE[locale];
}
