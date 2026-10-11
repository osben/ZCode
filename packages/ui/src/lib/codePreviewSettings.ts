/**
 * Types and defaults for code-preview settings.
 *
 * Keep this in a standalone neutral module: if it were defined in the zustand store (@/store/index.ts),
 * pure display components (ai-elements / ToolCallBlocks) would depend on the store just to access the types and defaults.
 * The store only re-exports these values; display components receive them as props and use this module’s defaults as fallback.
 */
import type { BundledTheme } from "shiki";

export interface CodePreviewSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}

export const DEFAULT_CODE_PREVIEW_SETTINGS: CodePreviewSettings = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
  fontSizePx: 12,
};
