#!/usr/bin/env node
// `pnpm fmt` / `pnpm fmt:check`: run oxfmt over the files the fork added or
// modified since the upstream sync base pinned in fork-upstream-base.json.
// Upstream does not format its tree; reformatting upstream-identical files
// would conflict on every upstream sync. Spec: specs/fork-format-scope.md.
//
// Usage: node scripts/fork-format.mjs [--check | --list]
//   (default)  format the selected files in place
//   --check    fail if any selected file is not formatted
//   --list     print the selected files without running oxfmt

import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveToolBin } from "./run-pre-commit-checks.mjs";

const execFileAsync = promisify(execFile);

export const UPSTREAM_BASE_FILE = "fork-upstream-base.json";

// The local remote-tracking ref used only for the stale-pin assertion.
const UPSTREAM_TRACKING_REF = "refs/remotes/upstream/main";

const FORMATTABLE_EXTENSIONS = new Set(
  [
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "mts",
    "cts",
    "json",
    "jsonc",
    "json5",
    "md",
    "mdx",
    "markdown",
    "yml",
    "yaml",
    "toml",
    "css",
    "scss",
    "less",
    "html",
    "htm",
    "vue",
    "graphql",
    "gql",
    "hbs",
    "handlebars",
  ].map((extension) => `.${extension}`),
);

// Extensionless names oxfmt formats as JSON.
const FORMATTABLE_BASENAMES = new Set([".prettierrc", ".babelrc", ".swcrc"]);

// Windows caps a command line at 32767 characters; leave room for the node
// and oxfmt bin paths plus flags.
const MAX_ARGV_CHARS = 24_000;

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitSucceeds(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function isFormattable(path) {
  const name = basename(path);
  return FORMATTABLE_BASENAMES.has(name) || FORMATTABLE_EXTENSIONS.has(extname(name).toLowerCase());
}

export function chunkPaths(paths, maxChars = MAX_ARGV_CHARS) {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const path of paths) {
    const cost = path.length + 1;
    if (current.length > 0 && currentChars + cost > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(path);
    currentChars += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function readPinnedCommit(repoRoot) {
  let raw;
  try {
    raw = await readFile(join(repoRoot, UPSTREAM_BASE_FILE), "utf8");
  } catch (error) {
    throw new Error(`cannot read ${UPSTREAM_BASE_FILE}: ${error.message}`);
  }
  let commit;
  try {
    commit = JSON.parse(raw).upstreamCommit;
  } catch (error) {
    throw new Error(`cannot parse ${UPSTREAM_BASE_FILE}: ${error.message}`);
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      `${UPSTREAM_BASE_FILE}: upstreamCommit must be a full 40-character lowercase commit SHA`,
    );
  }
  return commit;
}

export async function resolveUpstreamBase(repoRoot) {
  const commit = await readPinnedCommit(repoRoot);
  if (!(await gitSucceeds(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]))) {
    throw new Error(
      `upstream base ${commit} is not in this clone; shallow clone? use full history (CI: actions/checkout fetch-depth: 0)`,
    );
  }
  if (!(await gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]))) {
    throw new Error(
      `upstream base ${commit} from ${UPSTREAM_BASE_FILE} is not an ancestor of HEAD`,
    );
  }
  if (await gitSucceeds(repoRoot, ["rev-parse", "--verify", "--quiet", UPSTREAM_TRACKING_REF])) {
    const mergeBase = (await git(repoRoot, ["merge-base", "HEAD", UPSTREAM_TRACKING_REF])).trim();
    if (mergeBase !== commit) {
      throw new Error(
        `${UPSTREAM_BASE_FILE} is stale: it pins ${commit}, but merge-base HEAD upstream/main is ${mergeBase}. ` +
          `Set upstreamCommit to the upstream commit last merged (see specs/fork-format-scope.md).`,
      );
    }
  }
  return commit;
}

function splitNul(output) {
  return output.split("\0").filter((path) => path.length > 0);
}

async function isRegularFile(repoRoot, path) {
  try {
    return (await lstat(join(repoRoot, path))).isFile();
  } catch {
    return false;
  }
}

export async function listForkChangedFiles(repoRoot, base) {
  const [changed, untracked] = await Promise.all([
    // Base against the working tree: committed, staged and unstaged changes.
    git(repoRoot, ["diff", "-z", "--name-only", "--no-renames", "--diff-filter=AM", base]),
    git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  const candidates = [...new Set([...splitNul(changed), ...splitNul(untracked)])].filter(
    isFormattable,
  );
  const existing = await Promise.all(
    candidates.map(async (path) => ((await isRegularFile(repoRoot, path)) ? path : null)),
  );
  return existing.filter((path) => path !== null).sort();
}

function runOxfmt(repoRoot, oxfmtBin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [oxfmtBin, "--no-error-on-unmatched-pattern", ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--list");
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(" ")}`);
  }
  const check = args.includes("--check");

  const repoRoot = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  const base = await resolveUpstreamBase(repoRoot);
  const files = await listForkChangedFiles(repoRoot, base);

  if (args.includes("--list")) {
    for (const file of files) {
      console.log(file);
    }
    return 0;
  }
  if (files.length === 0) {
    console.log(`fmt: no fork-changed files since upstream base ${base.slice(0, 8)}`);
    return 0;
  }

  const oxfmtBin = resolveToolBin("oxfmt");
  let exitCode = 0;
  // Sequential on purpose: oxfmt already parallelizes across threads.
  for (const chunk of chunkPaths(files)) {
    const result = await runOxfmt(repoRoot, oxfmtBin, check ? ["--check", ...chunk] : chunk);
    if (result.code !== 0) {
      exitCode = result.code;
      console.error(result.output.trimEnd());
    }
  }
  const mode = check ? "check" : "write";
  const status = exitCode === 0 ? "ok" : "FAILED";
  console.log(
    `fmt (${mode}): ${files.length} fork-changed files since upstream base ${base.slice(0, 8)}, before oxfmt ignore rules: ${status}`,
  );
  return exitCode;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`fmt: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
