import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Columnar codec for workspace file entries (for worker/cross-process transport only; zero runtime dependencies).
 * Each line is `type\trelativePath` — name is the last segment of relativePath, and path is reconstructed from
 * rootPath rather than transmitted twice (measured 65.7MB → ~25MB for 370,000 entries).
 * Unix filenames may contain \t, \n, or \\, which are escaped when packed and restored when unpacked.
 *
 * Transport-shape choices (performance constraints):
 * - Return a bare string at the RPC top level to use the framework's String fast path (length prefix + raw bytes),
 *   avoiding JSON.stringify/parse escaping overhead for large strings containing \t\n (measured at 6–9s);
 * - Keep each message at or below WORKSPACE_FILE_ENTRIES_CHUNK_SIZE (~4MB): reassembling large messages on the renderer
 *   receiver causes a multi-second main-thread task (measured at 4.6–6.3s). Fetching chunks and yielding between them
 *   limits main-thread work to one small chunk (~50ms) at a time and keeps input responsive.
 */
const FIELD_SEPARATOR = "\t";
const LINE_SEPARATOR = "\n";

/** Target size of one chunk in characters; callers fetch chunks based on totalLength. */
export const WORKSPACE_FILE_ENTRIES_CHUNK_SIZE = 4_000_000;

function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

// Restore escapes in one regex pass (several times faster than a character loop, saving seconds of worker time across 370,000 rows).
const UNESCAPE_PATTERN = /\\(.)/g;

function unescapeField(value: string): string {
  return value.replace(UNESCAPE_PATTERN, (match, char: string) => {
    if (char === "t") {
      return "\t";
    }
    if (char === "n") {
      return "\n";
    }
    return char;
  });
}

export function packWorkspaceFileEntries(entries: WorkspaceFileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.type}${FIELD_SEPARATOR}${escapeField(entry.relativePath)}`);
  }
  return lines.join(LINE_SEPARATOR);
}

/**
 * Unpack and rebuild complete entries: derive name from the last segment of relativePath and
 * build path from rootPath (whether or not rootPath ends with a separator; use \ on Windows and / elsewhere).
 */
export function unpackWorkspaceFileEntries(packed: string, rootPath: string): WorkspaceFileEntry[] {
  if (packed.length === 0) {
    return [];
  }
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const prefix =
    rootPath.endsWith("/") || rootPath.endsWith("\\") ? rootPath : `${rootPath}${separator}`;
  const lines = packed.split(LINE_SEPARATOR);
  const entries: WorkspaceFileEntry[] = [];
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const tabAt = line.indexOf(FIELD_SEPARATOR);
    if (tabAt === -1) {
      continue;
    }
    const relativePath = unescapeField(line.slice(tabAt + 1));
    const lastSlash = relativePath.lastIndexOf("/");
    // Under a Windows root, convert separators in POSIX relative paths back to \ to match node:path.join.
    const pathPart = separator === "/" ? relativePath : relativePath.split("/").join("\\");
    entries.push({
      name: lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1),
      path: `${prefix}${pathPart}`,
      relativePath,
      type: line.slice(0, tabAt) === "directory" ? "directory" : "file",
    });
  }
  return entries;
}
