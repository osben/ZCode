import { delimiter, dirname } from "node:path";

/**
 * Make all child processes use the same Node runtime as the launcher.
 *
 * `mise run` executes TOML tasks through a shell. If another Node appears first in
 * the child shell's PATH, pnpm starts package scripts with the wrong runtime even
 * when mise selected the correct version for the task. Put the launcher's Node directory first
 * to pin the entire child-process chain without depending on the user's home directory layout.
 */
export function withPinnedNodePath(env, nodeExecutablePath) {
  const nodeDirectory = dirname(nodeExecutablePath);
  // Windows Node environment objects commonly use `Path`. Reading only uppercase `PATH` drops the directory containing pnpm.cmd
  // from the child environment, causing the internal pnpm call in dev:desktop to fail.
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  const existingPath = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const pathEntries = existingPath
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => entry !== nodeDirectory);

  return {
    ...env,
    [pathKey]: [nodeDirectory, ...pathEntries].join(delimiter),
  };
}
