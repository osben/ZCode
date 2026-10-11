import type { CSSProperties } from "react";

export const WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX = 136;
export const WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR =
  "var(--windows-caption-controls-right-inset)";
export const WINDOWS_CAPTION_CONTROL_WIDTH_VAR = "var(--windows-caption-control-width)";

type WindowsCaptionControlsStyle = CSSProperties & {
  "--windows-caption-controls-right-inset": string;
  "--windows-caption-control-width": string;
};

export function createWindowsCaptionControlsStyle(
  _fallbackRightInsetPx = WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX,
): WindowsCaptionControlsStyle {
  return {
    // Custom buttons scale with the page; after WCO is disabled, its geometry may still return the full window width and must not be used to calculate the safe area.
    "--windows-caption-controls-right-inset": `${WINDOWS_CAPTION_CONTROLS_DEFAULT_RIGHT_INSET_PX}px`,
    // The legacy settings-page caption menu still uses equal thirds; compact window controls use a fixed 28 px width.
    "--windows-caption-control-width": "calc(var(--windows-caption-controls-right-inset) / 3)",
  };
}

// Enable this style explicitly only for the Windows title-bar path to preserve the existing spacing of Linux's custom title bar.
export const WINDOWS_CAPTION_CONTROL_CLASS =
  "h-full w-[var(--windows-caption-control-width,46px)] rounded-none";
