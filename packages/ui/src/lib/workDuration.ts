/**
 * Duration wording such as “Worked for 1m 42s” (`chat.history.workedFor`), extracted from `ConversationTurnGroup`
 * so the “Time” cell in the workflow completion card and the collapsed turn-header label
 * match exactly: the same duration must look the same in both places.
 *
 * Rules: round seconds to the nearest integer, minimum 1 second; show only nonzero units among days / hours / minutes / seconds, with **at most two parts** (`1h 3m`,
 * no seconds); English abbreviated units are adjacent to the number, while other languages leave a space before the unit word.
 */
type FormatMessage = (descriptor: { id: string }) => string;

interface WorkDurationPart {
  value: number;
  /** Localized unit label (`m` / localized equivalent). */
  unit: string;
}

const UNIT_IDS = {
  day: "chat.history.duration.day",
  hour: "chat.history.duration.hour",
  minute: "chat.history.duration.minute",
  second: "chat.history.duration.second",
} as const;

/** Split into `[{value, unit}]` for places that lay out numbers and units separately (large figures in completion cards). */
export function workDurationParts(
  durationMs: number,
  formatMessage: FormatMessage,
): WorkDurationPart[] {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: WorkDurationPart[] = [];
  if (days > 0) parts.push({ value: days, unit: formatMessage({ id: UNIT_IDS.day }) });
  if (hours > 0) parts.push({ value: hours, unit: formatMessage({ id: UNIT_IDS.hour }) });
  if (minutes > 0) parts.push({ value: minutes, unit: formatMessage({ id: UNIT_IDS.minute }) });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: formatMessage({ id: UNIT_IDS.second }) });
  }
  return parts.slice(0, 2);
}

/**
 * Only English abbreviated units (`m` / `s`) are adjacent to numbers; leave a space before units in languages such as Chinese and Ukrainian.
 * The previous `zh-CN` check produced “1хв 42с” for uk-UA, so remove the space only for en-US.
 */
export function workDurationUnitSeparator(locale: string): string {
  return locale === "en-US" ? "" : " ";
}

export function formatWorkDuration(
  durationMs: number | undefined,
  formatMessage: FormatMessage,
  locale: string,
): string | null {
  if (durationMs === undefined) return null;
  const separator = workDurationUnitSeparator(locale);
  return workDurationParts(durationMs, formatMessage)
    .map((part) => `${part.value}${separator}${part.unit}`)
    .join(" ");
}

/** Round before splitting so a minute never renders with 60.0 seconds. */
export function formatRunningWorkDuration(
  durationMs: number,
  formatMessage: FormatMessage,
  locale: string,
): string {
  const tenths = Math.max(0, Math.round(durationMs / 100));
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = (tenths % 600) / 10;
  const separator = workDurationUnitSeparator(locale);
  const parts: string[] = [];
  if (hours) parts.push(`${hours}${separator}${formatMessage({ id: UNIT_IDS.hour })}`);
  if (hours || minutes)
    parts.push(`${minutes}${separator}${formatMessage({ id: UNIT_IDS.minute })}`);
  parts.push(`${seconds.toFixed(1)}${separator}${formatMessage({ id: UNIT_IDS.second })}`);
  return parts.join(" ");
}
