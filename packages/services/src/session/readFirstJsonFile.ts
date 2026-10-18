import { readFile } from "node:fs/promises";

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Reads and parses the first candidate file that exists, in order.
 * Existence is decided by the read itself so a file removed between a probe and the read cannot
 * surface as a spurious error. Only missing-file errors advance to the next candidate; invalid JSON
 * and other I/O errors reject so callers keep their own handling.
 */
export async function readFirstJsonFile(paths: readonly string[]): Promise<unknown | null> {
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    return JSON.parse(raw) as unknown;
  }
  return null;
}
