#!/usr/bin/env node
// Pre-commit checks over the staged file paths passed as argv (embedded by
// lint-staged.pre-commit.config.mjs). Runs the tools in a fixed order so they
// never race on the same file:
//   1. oxfmt rewrites files in place (its default mode); lint-staged then
//      re-stages the fixed content, so the commit contains formatted code.
//   2. oxlint checks the code files (JSON is not lintable — oxlint exits 1
//      with "No files found" on a JSON-only list) and blocks the commit on
//      error-severity findings, mirroring the `pnpm lint` step of pre-push.

import { spawnSync } from "node:child_process";

const LINTED_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

function normalizePath(file) {
  return file.replaceAll("\\", "/");
}

function suffixOf(file) {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot);
}

function runTool(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`pre-commit: failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const files = process.argv.slice(2).map(normalizePath);
if (files.length === 0) {
  process.exit(0);
}

runTool("oxfmt", files);

const lintedFiles = files.filter((file) => LINTED_SUFFIXES.has(suffixOf(file)));
if (lintedFiles.length > 0) {
  runTool("oxlint", lintedFiles);
}
