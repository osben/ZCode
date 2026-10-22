import { createHash } from "node:crypto";
import { readFileSync, type Stats } from "node:fs";
import { sep } from "node:path";

// Every discovery call (readPresentation, session runtime creation, skills) rebuilt the seed hash
// list by reading and hashing all bundled plugin bytes (~63 MB packaged), which dominated the
// synchronous plugin resolution on the CLI request queue. Hashes are reused only while the
// file's stat signature is unchanged; ctime and inode catch edits that preserve size and mtime.
// Stat happens before read, so a concurrent edit can only cause an extra re-hash later.
const filesystemSeedHashMemo = new Map<string, { signature: string; sha256: string }>();

export function hashFilesystemSeedFile(sourcePath: string, stats: Stats): string {
  const signature = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
  const memo = filesystemSeedHashMemo.get(sourcePath);
  if (memo?.signature === signature) return memo.sha256;
  const sha256 = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  filesystemSeedHashMemo.set(sourcePath, { signature, sha256 });
  return sha256;
}

export function pruneFilesystemSeedHashMemo(rootPath: string, visited: ReadonlySet<string>): void {
  const prefix = `${rootPath}${sep}`;
  for (const sourcePath of filesystemSeedHashMemo.keys()) {
    if (sourcePath.startsWith(prefix) && !visited.has(sourcePath)) {
      filesystemSeedHashMemo.delete(sourcePath);
    }
  }
}
