import type { ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";

/** Trailing "· 4s" summary for a finished aggregate stage (Explore/Execute); hidden while the stage runs. */
export function useStageDurationText(
  durationMs: number | undefined,
  isRunning: boolean,
): ReactNode | undefined {
  const { intl, locale } = useZCodeIntl();
  const label = isRunning ? null : formatConversationWorkDuration(durationMs, intl, locale);
  if (!label) return undefined;
  return (
    <>
      <span className="shrink-0">·</span>
      <span className="shrink-0 tabular-nums">{label}</span>
    </>
  );
}
