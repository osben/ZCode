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
  // 默认正文是中文：英文界面沿用原有的 zh 回退；其他语言优先英文，避免直接展示中文（D14）。
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
    // update feed 的 releaseDate 通常是 UTC 零点。按用户本地时区格式化会让
    // 美洲等时区显示成前一天，hover 中只展示发布日期时应保持 feed 日期稳定。
    timeZone: "UTC",
  }).format(date);
}
