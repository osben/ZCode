import type { ZCodeModelTrajectoryTruncation } from "../contract.js";

const SEPARATOR = "\n…\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cut text to `budgetBytes` of UTF-8: three quarters head, the rest tail, joined by a separator, both cut on
 * character boundaries. Mirrors the v1 part budget with a caller-chosen size.
 */
export function boundTextTo(
  text: string,
  budgetBytes: number,
): { text: string; truncated?: ZCodeModelTrajectoryTruncation } {
  const bytes = encoder.encode(text);
  if (bytes.length <= budgetBytes) return { text };
  const separatorBytes = encoder.encode(SEPARATOR).length;
  const headBytes = Math.floor(budgetBytes * 0.75);
  const tailBytes = Math.max(0, budgetBytes - separatorBytes - headBytes);
  let headEnd = headBytes;
  while (headEnd > 0 && isContinuation(bytes[headEnd])) headEnd -= 1;
  let tailStart = bytes.length - tailBytes;
  while (tailStart < bytes.length && isContinuation(bytes[tailStart])) tailStart += 1;
  const kept = headEnd + (bytes.length - tailStart);
  return {
    text:
      decoder.decode(bytes.subarray(0, headEnd)) +
      SEPARATOR +
      decoder.decode(bytes.subarray(tailStart)),
    truncated: { originalBytes: bytes.length, omittedBytes: bytes.length - kept },
  };
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
