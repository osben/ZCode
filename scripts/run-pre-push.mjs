#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { resolveDiffTarget } from "./run-affected-unit-tests.mjs";

const exec = promisify(execFile);
const root = process.cwd();
const started = performance.now();
const elapsed = (start) => `${((performance.now() - start) / 1000).toFixed(2)}s`;
const print = (message) => console.log(`[pre-push] ${message}`);

async function isDocumentationOnly() {
  const refs = (process.env.ZCODE_PRE_PUSH_STDIN ?? "").trim().split(/\r?\n/u).filter(Boolean);
  if (refs.length > 1) return false;
  const target = resolveDiffTarget(root);
  if (!target) return false;
  const git = async (args) =>
    (await exec("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const base = target.useMergeBase
    ? (await git(["merge-base", target.base, target.head])).trim()
    : target.base;
  // Include both sides of renames: moving code to docs still changes code.
  const files = (await git(["diff", "--name-only", "--no-renames", "-z", base, target.head]))
    .split("\0")
    .filter(Boolean);
  return (
    files.length > 0 && files.every((file) => /^(?:[^/]+\.md|(?:docs|specs)\/.+\.md)$/u.test(file))
  );
}

async function runStage(task, args = []) {
  const stageStarted = performance.now();
  print(`${task} started`);
  const status = await new Promise((resolve, reject) => {
    // pnpm may provide either a native executable or a JS entry point.
    const pnpmCli = process.env.npm_execpath;
    const isScript = /\.[cm]?js$/u.test(pnpmCli);
    const command = isScript ? process.execPath : pnpmCli;
    const commandArgs = ["run", task, ...args];
    const child = spawn(command, isScript ? [pnpmCli, ...commandArgs] : commandArgs, {
      cwd: root,
      env: {
        ...process.env,
        NODE_COMPILE_CACHE:
          process.env.NODE_COMPILE_CACHE || join(root, ".cache", "pre-push", "node-compile"),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  print(`${task} ${status === 0 ? "passed" : `failed (${status})`} in ${elapsed(stageStarted)}`);
  return status;
}

async function main() {
  if (!process.env.npm_execpath) {
    throw new Error("Run this gate with pnpm run verify:pre-push.");
  }
  const docsOnly = await isDocumentationOnly();
  const stages = [["lint"], ["architecture:check", ["--", "--changed"]], ["test-copy:check"]];
  if (!docsOnly) stages.push(["test:unit:affected"], ["test:node"]);
  for (const [task, args] of stages) {
    const status = await runStage(task, args);
    if (status !== 0) return status;
  }
  if (docsOnly) print("documentation-only changes: skip test:unit:affected and test:node");
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[pre-push] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  print(`total ${elapsed(started)}`);
}
