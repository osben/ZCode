#!/usr/bin/env node
// Pre-commit checks over the staged file paths passed as argv (appended to
// string tasks by lint-staged.pre-commit.config.mjs). Runs the tools in a
// fixed order so they never race on the same file:
//   1. oxfmt rewrites files in place (its default mode); lint-staged then
//      re-stages the fixed content, so the commit contains formatted code.
//   2. oxlint checks whatever it considers lintable among the same files and
//      blocks the commit on error-severity findings, mirroring the `pnpm
//      lint` step of the pre-push hook.
//
// Which files each tool actually processes is the tool's own decision:
// oxfmt honors .prettierignore (apps/zcode-cli/ ships its own newer oxfmt)
// and oxlint honors .oxlintrc.json ignorePatterns plus file extensions. Both
// tools run with --no-error-on-unmatched-pattern so that a fully filtered
// file set (for example a CLI-only commit) is not an error. Exit codes stay
// authoritative: any other failure blocks the commit, regardless of its
// diagnostic text.
//
// Tools are launched as `process.execPath <package bin .js>`: npm/pnpm expose
// package bins through .cmd shims on Windows, which spawnSync cannot execute
// without a shell, and both oxlint and oxfmt ship JavaScript bin launchers.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveToolBin(packageName) {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const binField = JSON.parse(readFileSync(packageJsonPath, "utf8")).bin;
  const binRelativePath = typeof binField === "string" ? binField : binField[packageName];
  if (!binRelativePath) {
    throw new Error(`pre-commit: package ${packageName} declares no bin`);
  }
  const binPath = join(dirname(packageJsonPath), binRelativePath);
  if (!existsSync(binPath)) {
    throw new Error(`pre-commit: bin not found for ${packageName}: ${binPath}`);
  }
  return binPath;
}

function runTool(packageName, args) {
  const result = spawnSync(
    process.execPath,
    [resolveToolBin(packageName), "--no-error-on-unmatched-pattern", ...args],
    { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.error) {
    console.error(`pre-commit: failed to run ${packageName}: ${result.error.message}`);
    process.exit(1);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    if (output.trim().length > 0) {
      console.error(output.trimEnd());
    }
    process.exit(result.status ?? 1);
  }
  if (output.trim().length > 0) {
    // Non-blocking tool output (e.g. oxlint warnings) stays visible.
    console.log(output.trimEnd());
  }
}

function main() {
  const files = process.argv.slice(2).map((file) => file.replaceAll("\\", "/"));
  if (files.length === 0) {
    return;
  }

  runTool("oxfmt", files);
  runTool("oxlint", files);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
