export function formatCompactTokenNumber(
  locale: string,
  value: number,
  options: { maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) {
    return "";
  }

  const maximumFractionDigits = options.maximumFractionDigits ?? 1;
  const absValue = Math.abs(value);

  // Token counts should still use localized compact formatting: Chinese displays 万/亿, while English displays K/M/B.
  // A previous fix for long English units in Start Plan incorrectly forced K/M/B for every locale.
  return new Intl.NumberFormat(locale || undefined, {
    notation: absValue >= 1_000 ? "compact" : "standard",
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatModelContextWindowLabel(contextWindow: number, _locale = "en-US"): string {
  // Capacity badges in the model list are technical specifications and should not switch to 万/亿 in the Chinese locale.
  return formatCompactTokenNumber("en-US", contextWindow);
}
