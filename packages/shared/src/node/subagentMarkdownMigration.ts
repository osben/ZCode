import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { migrateSubagentMarkdownProvider } from "../subagent-markdown-selection.js";
import { importSubagentStateSelections } from "../subagent-state-migration.js";
import { withFileLock } from "./privateFilePersistence.js";

interface SubagentMarkdownMigrationResult {
  migrated: string[];
  failures: Array<{ path: string; error: unknown }>;
}

/** Shared atomic import boundary: legacy JSON fields are interpreted only here; after writing, readers use only the current fields. */
export async function migrateSubagentStateFile(path: string): Promise<void> {
  try {
    await migrateFile(path, (original) => {
      const parsed: unknown = JSON.parse(original);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return original;
      const next = importSubagentStateSelections(parsed as Record<string, unknown>);
      return JSON.stringify(next) === JSON.stringify(parsed)
        ? original
        : JSON.stringify(next, null, 2);
    });
  } catch (error) {
    // Preserve the existing empty-override semantics for corrupted files without overwriting the original; IO errors must not be mistaken for a successful migration.
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function migrateFile(
  path: string,
  transform: (original: string) => string,
): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile()) return false;
  return withFileLock(path, async () => {
    const before = await lstat(path);
    if (!before.isFile() || (before.mode & 0o222) === 0) return false;
    const original = await readFile(path, "utf8");
    const next = transform(original);
    if (next === original) return false;
    const directory = dirname(path);
    const physicalDirectory = await realpath(directory);
    const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, next, { flag: "wx", mode: before.mode & 0o777 });
      await chmod(temp, before.mode & 0o777);
      // External editors do not hold the application lock; compare the original content and file identity before writing so concurrent changes are not overwritten.
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        (await realpath(directory)) !== physicalDirectory ||
        (await readFile(path, "utf8")) !== original
      ) {
        throw new Error("Subagent file changed during migration");
      }
      await rename(temp, path);
      return true;
    } finally {
      await rm(temp, { force: true });
    }
  });
}

/** Callers pass only the user agents root for their environment; project/plugin directories must not enter the automatic write path. */
export async function migrateUserSubagentMarkdown(
  userRoot: string,
): Promise<SubagentMarkdownMigrationResult> {
  const result: SubagentMarkdownMigrationResult = { migrated: [], failures: [] };
  async function visit(directory: string): Promise<void> {
    try {
      // Do not follow links inside the user directory to write into project/plugin or other directories.
      const rootStat = await lstat(directory);
      if (!rootStat.isDirectory()) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
          try {
            if (await migrateFile(path, migrateSubagentMarkdownProvider))
              result.migrated.push(path);
          } catch (error) {
            result.failures.push({ path, error });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        result.failures.push({ path: directory, error });
    }
  }
  await visit(userRoot);
  return result;
}
