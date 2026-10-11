/**
 * Deterministic hash implemented in this package: FNV-1a (32-bit) over canonical JSON.
 * Do not use node:crypto—src/ stays pure and portable, and the hash is only a defensive consistency
 * check during replay (not for cryptography; collision resistance is not important, while
 * determinism and portability are).
 */

/**
 * Canonical JSON serialization: sort object keys by code point to give semantically equivalent
 * values a stable byte sequence.
 * Covers only JSON values used by host calls (string/number/boolean/null/array/plain object).
 * Non-JSON values such as undefined/functions should not reach this path; serialize them as "null"
 * to keep the function total if they do.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // Primitives: delegate to JSON.stringify (number/boolean/string); undefined/functions fall back to null.
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    // Skip undefined members, matching JSON.stringify's object semantics.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** 32-bit FNV-1a hash, output as an 8-character hexadecimal string. */
export function fnv1a(input: string): string {
  // FNV offset basis / prime (32-bit). Use Math.imul to guarantee 32-bit multiplication wraparound.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Include the high byte too so hashing only low bytes does not lose distinctions between multibyte characters.
    hash ^= (input.charCodeAt(i) >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned and zero-pad to 8 hexadecimal characters.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Compute a defensive hash for host-call input: apply FNV-1a to canonical JSON. */
export function inputHash(value: unknown): string {
  return fnv1a(canonicalJson(value));
}
