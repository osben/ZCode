/**
 * Splits a client-supplied relative path into safe segments, or returns null.
 * String-level checks run before any filesystem access; the adapter still confines every
 * segment with lstat, so this is the first of two independent gates.
 */
export function parseDefinitionRelativePath(raw: string): string[] | null {
  if (raw.length === 0 || raw.includes("\0")) return null;
  // Absolute POSIX paths, UNC paths (\\server\share) and drive letters (C:, C:\) never name a child.
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw)) return null;
  const segments = raw.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    // A colon inside a segment is an NTFS alternate data stream or a drive-relative path.
    if (segment.includes(":")) return null;
  }
  return segments;
}
