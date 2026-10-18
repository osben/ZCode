// ============================================================
// file:// URI helpers (pure string/URL transforms, no I/O)
// ============================================================
// Servers echo back URIs with their own percent-encoding (for example `b%40c.ts` for `b@c.ts`, and
// `c%3A` for a Windows drive colon), so keys are canonicalized by decoding to a path and re-encoding.
// Comparing raw strings silently dropped every publish whose spelling differed.

import { fileURLToPath, pathToFileURL } from "node:url";

const WINDOWS_DRIVE_URI_PATTERN = /^file:\/\/\/([A-Za-z]):/u;

/**
 * Canonical key for a file URI: decode to a path, re-encode with the platform's rules, and lower-case the
 * drive letter. Anything that is not a file URI is returned unchanged.
 */
export function normalizeFileUri(uri: string): string {
  let canonical = uri;
  try {
    canonical = pathToFileURL(fileURLToPath(uri)).href;
  } catch {
    // Not a decodable file URI; keep the given spelling so it can still match a key we sent.
  }
  return canonical.replace(WINDOWS_DRIVE_URI_PATTERN, (_match, drive: string) => {
    return `file:///${drive.toLowerCase()}:`;
  });
}

export function toFileUri(absolutePath: string): string {
  return normalizeFileUri(pathToFileURL(absolutePath).href);
}

export function fromFileUri(uri: string): string {
  return fileURLToPath(uri);
}
