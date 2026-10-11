import type { HighlighterTypes } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

/**
 * @pierre/diffs uses shiki’s JavaScript regex engine (shiki-js) by default. This engine translates TextMate
 * grammars into huge RegExp objects and retains them permanently in an engine-level cache. V8 compiles executed regexes to native code in
 * code space; double-byte text (such as Chinese comments) compiles another copy. The main window and four diff workers share the same
 * 256 MB code range, which these regexes can fill over time and cause a renderer V8 OOM
 * (CALL_AND_RETRY_LAST, with plenty of old-space free and code cage “ran out of reservation”).
 * The oniguruma WASM engine keeps regexes in WASM linear memory, not V8 code space, and is the reference implementation for TextMate grammars.
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

export interface DiffsHighlighterThemeSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
}

/** Diff-worker pool initialization options; main-thread fallback rendering and the worker must use the same engine choice. */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // Word-level diff calculations across patches add main-thread work; keep the library’s default threshold for now,
    // and tighten it later based on slow-operation logs to avoid a regression where highlighted text suddenly disappears.
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}
