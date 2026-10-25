/**
 * Synchronize only the default title auto-filled on the creation page.
 *
 * The default title used to read locale only during form initialization, so after a language switch other text updated while the input kept the old language.
 * User input, template drafts, and saved task titles are business data and must not be overwritten when the interface language changes.
 */
export function resolveLocalizedAutomationCreateTitle({
  currentTitle,
  hasInitialDraft,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialDraft: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialDraft || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}
