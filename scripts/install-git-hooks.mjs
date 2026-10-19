import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveToolBin } from "./run-pre-commit-checks.mjs";

const exec = promisify(execFile);
let hooksPath = "";
try {
  hooksPath = (await exec("git", ["config", "--get", "core.hooksPath"])).stdout.trim();
} catch (error) {
  if (error.code !== 1) throw error;
}

// Keep the inherited relative Husky path: changing shared Git configuration
// would switch the hook manager in sibling worktrees as well.
const args = ["install", ...(hooksPath === ".husky/_" ? ["--force"] : [])];
const child = spawn(process.execPath, [resolveToolBin("lefthook"), ...args], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Unable to install Git hooks: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
