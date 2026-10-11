// ============================================================
// Token Estimation
// ============================================================

import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";

/**
 * Estimate the number of tokens in text.
 * Use the shared character-based divisor and retain extra weight for Chinese characters.
 * This is a rough estimate, sufficient for debugging and monitoring.
 */
export function estimateTokens(text: string): number {
  // Chinese characters usually take more tokens than English characters, so count each as two estimated characters.
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
