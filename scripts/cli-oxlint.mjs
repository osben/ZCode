import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Runs the oxlint that Node resolves from `cwd` (the version that package installed).
 * `pnpm exec` is avoided on purpose: a native pnpm cannot be run through node, and inside
 * the nested apps/zcode-cli workspace pnpm first runs a verify-deps install that fails.
 */
export async function runOxlint(cwd, args) {
  let manifestPath;
  try {
    manifestPath = createRequire(join(cwd, "package.json")).resolve("oxlint/package.json");
  } catch (error) {
    throw new Error(`oxlint is not installed for ${cwd}; run pnpm install`, { cause: error });
  }
  const { bin } = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = resolve(dirname(manifestPath), typeof bin === "string" ? bin : bin.oxlint);
  try {
    return {
      code: 0,
      ...(await exec(process.execPath, [entry, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 })),
    };
  } catch (error) {
    if (error.code !== 1 || !error.stdout) throw error;
    return { code: 1, stdout: error.stdout, stderr: error.stderr };
  }
}
