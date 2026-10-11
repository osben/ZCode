import { stat } from "node:fs/promises";

/** Select only the execution directory; do not catch database errors. If no fallback directory is available, keep the original path so startup reports the normal error. */
export async function resolveZCodeAgentSpawnCwd(
  options: { requestedCwd: string; workspacePath: string; spawnFallbackCwd?: string },
  probe: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<{ cwd: string; usedFallback: boolean; cwdExists: boolean }> {
  const usable = async (path: string | undefined) => {
    if (!path) return false;
    try {
      return (await probe(path)).isDirectory();
    } catch {
      // The legacy Agent uses a fallback cwd for any invalid historical directory; ENOTDIR/EACCES must preserve this behavior too.
      return false;
    }
  };
  const cwdExists = await usable(options.requestedCwd);
  if (
    options.requestedCwd === options.workspacePath &&
    !cwdExists &&
    (await usable(options.spawnFallbackCwd))
  )
    return { cwd: options.spawnFallbackCwd!, usedFallback: true, cwdExists: true };
  return { cwd: options.requestedCwd, usedFallback: false, cwdExists };
}
