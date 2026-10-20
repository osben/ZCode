import type { Locale, PostUpdateReleaseNotesPayload } from "@zcode/shared";

export type LocalizedUpdateReleaseNotes = {
  title: string;
  markdown: string;
};

export function getLocalizedUpdateReleaseNotes(
  payload: PostUpdateReleaseNotesPayload | undefined,
  locale: Locale,
): LocalizedUpdateReleaseNotes | null {
  if (!payload) {
    return null;
  }

  const defaultReleaseNotes = {
    title: payload.title,
    markdown: payload.markdown,
  };

  const byLocale = payload.releaseNotesByLocale;
  if (byLocale?.[locale]) {
    return byLocale[locale];
  }
  if (locale === "zh-CN") {
    return defaultReleaseNotes;
  }
  // The default body is Chinese: the English UI keeps the existing zh fallback; other languages prefer English to avoid displaying Chinese directly (D14).
  if (locale === "en-US") {
    return byLocale?.["zh-CN"] ?? defaultReleaseNotes;
  }
  return byLocale?.["en-US"] ?? defaultReleaseNotes;
}

export function formatUpdateReleaseDate(
  releaseDate: string | undefined,
  locale: Locale,
): string | null {
  if (!releaseDate) {
    return null;
  }

  const date = new Date(releaseDate);
  if (Number.isNaN(date.getTime())) {
    return releaseDate;
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    // The update feed’s releaseDate is usually midnight UTC. Formatting in the user’s local time zone can make
    // it appear as the previous day in the Americas and other time zones; keep the feed date stable when hover shows only the release date.
    timeZone: "UTC",
  }).format(date);
}
