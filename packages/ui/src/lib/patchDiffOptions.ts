import type { FileDiffOptions } from "@pierre/diffs";
import type { BundledTheme } from "shiki";

import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";
import type { ResolvedTheme } from "@/useTheme.js";

interface PatchDiffSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

type PatchDiffSeparatorStyle = "line-info" | "simple";

const PATCH_DIFF_UNSAFE_CSS = `
/* Fix reason: PatchDiff renders inside a Shadow DOM, so outer Tailwind selectors cannot reach the
 * internal code nodes. This must be injected into the shadow root via unsafeCSS to actually
 * override the library's own code padding and background color.
 * Additionally, the library makes the left gutter sticky during horizontal scrolling; if the
 * background were transparent, body text would "show through" under the line-number column,
 * visually overlapping line numbers and text while dragging the scrollbar. */
:host {
  --diffs-light-bg: var(--color-background, #fff);
  --diffs-dark-bg: var(--color-background, #000);
}

[data-code],
[data-separator-content],
pre {
  padding: 0 !important;
  background: transparent !important;
}

[data-code] span,
[data-separator-content] span {
  background: transparent !important;
}

[data-code] {
  background-color: transparent !important;
}

[data-separator-wrapper] {
  padding-left: 64px !important;
}

[data-separator-wrapper] {
  background: var(--color-surface) !important;
}

[data-separator-content] {
  background-color: transparent !important;
}
[data-column-number] {
  border-right-color: rgba(0, 0, 0, 0.1) !important;
}
`;

export function createPatchDiffOptions(
  codePreviewSettings: PatchDiffSettings,
  resolvedTheme: ResolvedTheme,
  options?: {
    separatorStyle?: PatchDiffSeparatorStyle;
  },
): FileDiffOptions<undefined> {
  return {
    diffStyle: "unified",
    diffIndicators: "classic",
    disableFileHeader: true,
    disableLineNumbers: !codePreviewSettings.showLineNumbers,
    // Bugfix: compact diffs like "changes from the previous round" prioritize quickly locating
    // modifications and do not need the extra "123 unmodified lines" label. Callers may switch to
    // simple here, degrading large unchanged regions into lightweight blank separators so they do
    // not visually steal attention from the changes themselves.
    hunkSeparators: options?.separatorStyle ?? "line-info",
    overflow: codePreviewSettings.wrapLongLines ? "wrap" : "scroll",
    theme: {
      light: codePreviewSettings.lightTheme,
      dark: codePreviewSettings.darkTheme,
    },
    themeType: resolvedTheme,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
    unsafeCSS: PATCH_DIFF_UNSAFE_CSS,
  };
}
