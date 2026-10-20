/**
 * Composer autofocus decision (pure function, independent of React/DOM for unit testing).
 *
 * Creating a task (startDraft increments draftFocusVersion) / switching sessions (sessionId→scope changes) / mounting
 * all request focus to return to the input, but whether focus actually happens depends on three states:
 * - `skip`: disabled (for example, a vertically split background pane with autoFocusEnabled=false) or mobile viewport
 *   (autofocus opens the soft keyboard and can be disruptive) — do not focus or save the intent.
 * - `defer`: enabled, but the composer is temporarily not editable (briefly disabled when switching to a connecting session) — store the focus intent
 *   and fulfill it once when disabled→false makes editing possible.
 * - `focus-now`: enabled and editable; focus immediately.
 */
export type ComposerAutoFocusDecision = "focus-now" | "defer" | "skip";

export interface ComposerAutoFocusOptions {
  /** Host gate (SessionPane.focused): only the focused pane auto-focuses. */
  autoFocusEnabled: boolean;
  /** Whether the composer is non-editable (v4: sessionId is connecting). */
  disabled: boolean;
  /** Whether this is a mobile text-input viewport. */
  isMobileViewport: boolean;
}

export function resolveComposerAutoFocus({
  autoFocusEnabled,
  disabled,
  isMobileViewport,
}: ComposerAutoFocusOptions): ComposerAutoFocusDecision {
  if (!autoFocusEnabled || isMobileViewport) return "skip";
  if (disabled) return "defer";
  return "focus-now";
}
