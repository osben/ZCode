import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
// Each entry keeps a full ThemedToken grid; without a bound, every diff ever rendered stayed alive for the
// renderer's lifetime. Map insertion order doubles as LRU order (hits are re-inserted). Bounded by entry count
// and by total source characters, since a single input may be up to ~120k chars (spec: renderer-cache-bounds).
export const SHIKI_TOKENS_CACHE_MAX_ENTRIES = 200;
export const SHIKI_TOKENS_CACHE_MAX_CODE_CHARS = 2_000_000;
// One retry per highlighter key per app session: a persistent WASM/grammar failure must not re-init on every mount.
export const SHIKI_HIGHLIGHTER_MAX_ATTEMPTS = 2;
const tokensCache = new Map<string, { tokenized: TokenizedCode; codeChars: number }>();
let tokensCacheCodeChars = 0;
const highlighterFailures = new Map<string, number>();
const loggedHighlightErrors = new WeakSet<object>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
// In-memory diagnostic counter for the token cache and highlighter instances.
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  tokensCacheCodeChars,
  highlighters: highlighterCache.size,
}));

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

// Key on the full code: a length + head/tail sample collided for blocks that differ only in the middle,
// returning another block's tokens and sharing its subscribers.
const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) =>
  `${theme}:${language}:${code}`;

const forgetTokens = (key: string) => {
  const entry = tokensCache.get(key);
  if (!entry) return;
  tokensCache.delete(key);
  tokensCacheCodeChars -= entry.codeChars;
};

const rememberTokens = (key: string, tokenized: TokenizedCode, codeChars: number) => {
  forgetTokens(key);
  tokensCache.set(key, { tokenized, codeChars });
  tokensCacheCodeChars += codeChars;
  // Always keep the newest entry, even if it alone exceeds the character budget.
  while (
    tokensCache.size > 1 &&
    (tokensCache.size > SHIKI_TOKENS_CACHE_MAX_ENTRIES ||
      tokensCacheCodeChars > SHIKI_TOKENS_CACHE_MAX_CODE_CHARS)
  ) {
    const oldestKey = tokensCache.keys().next().value;
    if (oldestKey === undefined) break;
    forgetTokens(oldestKey);
  }
};
const getHighlighter = (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cacheKey = `${theme}:${language}`;
  const cached = highlighterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: [theme],
  });

  highlighterCache.set(cacheKey, highlighterPromise);
  // Allow one retry after a transient failure; once attempts are exhausted the rejection stays cached so
  // later mounts fall back to plain text without re-initializing Shiki.
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
  highlighterPromise.catch(() => {
    const failures = (highlighterFailures.get(cacheKey) ?? 0) + 1;
    highlighterFailures.set(cacheKey, failures);
    if (
      failures < SHIKI_HIGHLIGHTER_MAX_ATTEMPTS &&
      highlighterCache.get(cacheKey) === highlighterPromise
    ) {
      highlighterCache.delete(cacheKey);
    }
  });
  return highlighterPromise;
};

export const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// Cached asynchronous highlighting entry point; React components should call it only in an effect.
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // Plain-text/log code blocks gain nothing from syntax highlighting, yet enter
    // Shiki's async state machine during chat streaming and history restoration. The render-phase setState issue was fixed earlier, but this plain-text path could still put
    // CodeViewer into React #185; return raw tokens directly to avoid starting highlighting side effects.
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cachedEntry = tokensCache.get(tokensCacheKey);
  if (cachedEntry) {
    const cached = cachedEntry.tokenized;
    rememberTokens(tokensCacheKey, cached, cachedEntry.codeChars);
    // Notify the effect on a cache hit too, but do not trigger setState synchronously.
    // Many code blocks mount in the same commit when restoring history; a synchronous callback turns a cache hit into a nested update,
    // which can trigger React #185 when combined with Streamdown rerenders. Defer to a microtask, then use the idempotent setter.
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      rememberTokens(tokensCacheKey, tokenized, code.length);

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
      subscribers.delete(tokensCacheKey);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // If Shiki loading or tokenization fails, the component stays in the unhighlighted rawTokens state.
      subscribers.delete(tokensCacheKey);
      // A cached (exhausted) highlighter rejection reaches every later call; log each distinct error once.
      if (typeof error === "object" && error !== null) {
        if (loggedHighlightErrors.has(error)) return;
        loggedHighlightErrors.add(error);
      }
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
    });

  return null;
};
