/**
 * IDs, URLs, keys, and JSON in Provider / Model configuration are technical fields, not natural language.
 * Disable spellcheck and autocorrect consistently to prevent misleading underlines or system changes to model IDs.
 */
export const TECHNICAL_INPUT_ATTRIBUTES = {
  autoCapitalize: "none",
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;
