// ============================================================
// file:// URI helpers (pure string/URL transforms, no I/O)
// ============================================================

import { fileURLToPath, pathToFileURL } from "node:url";

const WINDOWS_DRIVE_URI_PATTERN = /^file:\/\/\/([A-Za-z]):/u;

/**
 * Normalizes the drive letter to lower case so that the same file maps to one key
 * whichever side (our path or the server's publish) produced the URI (spec §8 Windows).
 */
export function normalizeFileUri(uri: string): string {
  return uri.replace(WINDOWS_DRIVE_URI_PATTERN, (_match, drive: string) => {
    return `file:///${drive.toLowerCase()}:`;
  });
}

export function toFileUri(absolutePath: string): string {
  return normalizeFileUri(pathToFileURL(absolutePath).href);
}

export function fromFileUri(uri: string): string {
  return fileURLToPath(uri);
}
