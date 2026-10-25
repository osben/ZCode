#!/usr/bin/env node
// Git plumbing shared by scripts/fork-format.mjs (pnpm fmt / fmt:check), the
// pre-commit wrapper (scripts/run-pre-commit-checks.mjs) and the commit size
// guard (scripts/check-staged-file-tokens.mjs): the pending-upstream exemption
// from specs/fork-format-scope.md, plus helpers for batched git calls. All
// callers must drop the same files, so the comparison lives here.
//
// Usage: node scripts/fork-format-pending.mjs --fetch
//   Fetches the pending upstream commit by URL when it is missing (CI step).

import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UPSTREAM_BASE_FILE = "fork-upstream-base.json";

// Fetched by URL, never through a configured remote, so no refs/remotes/upstream/*
// is created and the fork-format stale-pin assertion stays off.
export const PENDING_UPSTREAM_URL = "https://github.com/zai-org/ZCode.git";

// Windows caps a command line at 32767 characters; leave room for the node
// and oxfmt bin paths plus flags.
const MAX_ARGV_CHARS = 24_000;

export async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function gitSucceeds(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
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

function splitNul(output) {
  return output.split("\0").filter((entry) => entry.length > 0);
}

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

function parsePendingCommit(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${UPSTREAM_BASE_FILE}: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${UPSTREAM_BASE_FILE} must contain a JSON object`);
  }
  if (!Object.hasOwn(parsed, "pendingUpstreamCommit")) {
    return null;
  }
  const commit = parsed.pendingUpstreamCommit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      `${UPSTREAM_BASE_FILE}: pendingUpstreamCommit must be a full 40-character lowercase commit SHA`,
    );
  }
  return commit;
}

// The pending commit named by the pin, or null when the field is absent.
// source "worktree" reads the file on disk (fmt, fmt:check); source "index"
// reads the staged blob (pre-commit hook, size guard). A missing index entry
// means no exemption.
export async function readPendingCommit(repoRoot, source = "worktree") {
  if (source === "index") {
    if (!(await gitSucceeds(repoRoot, ["cat-file", "-e", `:${UPSTREAM_BASE_FILE}`]))) {
      return null;
    }
    return parsePendingCommit(await git(repoRoot, ["show", `:${UPSTREAM_BASE_FILE}`]));
  }
  let raw;
  try {
    raw = await readFile(join(repoRoot, UPSTREAM_BASE_FILE), "utf8");
  } catch (error) {
    throw new Error(`cannot read ${UPSTREAM_BASE_FILE}: ${error.message}`);
  }
  return parsePendingCommit(raw);
}

async function hasCommit(repoRoot, commit) {
  return gitSucceeds(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
}

// Loads the exemption: null when the field is absent, otherwise the commit and
// a Map from path to blob id for the regular files of that commit.
export async function loadPendingUpstream(repoRoot, source = "worktree") {
  const commit = await readPendingCommit(repoRoot, source);
  if (commit === null) {
    return null;
  }
  if (!(await hasCommit(repoRoot, commit))) {
    throw new Error(
      `pending upstream commit ${commit} from ${UPSTREAM_BASE_FILE} is not in this clone; run \`git fetch upstream\``,
    );
  }
  const blobs = new Map();
  // "<mode> SP <type> SP <object> TAB <path>" per entry, NUL-terminated with -z.
  for (const entry of splitNul(
    await git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]),
  )) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type === "blob" && REGULAR_FILE_MODES.has(mode)) {
      blobs.set(entry.slice(tab + 1), object);
    }
  }
  return { commit, blobs };
}

// Fetches the pending commit by URL when the pin names a commit the clone lacks.
// No-op when the field is absent or the commit is already present.
export async function fetchPendingUpstream(repoRoot, url = PENDING_UPSTREAM_URL) {
  const commit = await readPendingCommit(repoRoot, "worktree");
  if (commit === null || (await hasCommit(repoRoot, commit))) {
    return;
  }
  try {
    // Writes only FETCH_HEAD; no remote-tracking ref is created.
    await git(repoRoot, ["fetch", "--no-tags", url, commit]);
  } catch (error) {
    throw new Error(
      `cannot fetch pending upstream commit ${commit} from ${url}: ${error.stderr?.trim() || error.message}`,
    );
  }
  if (!(await hasCommit(repoRoot, commit))) {
    throw new Error(`fetched from ${url} but pending upstream commit ${commit} is still missing`);
  }
}

// Working-tree blob ids as git would commit them: `git hash-object <file>`
// applies the same clean filters and eol normalization as `git add`. The
// output has one line per file, in argument order.
async function worktreeBlobIds(repoRoot, paths) {
  const ids = new Map();
  for (const chunk of chunkPaths(paths)) {
    const lines = (await git(repoRoot, ["hash-object", "--", ...chunk])).split("\n");
    if (lines.length !== chunk.length + 1 || lines[chunk.length] !== "") {
      throw new Error("git hash-object returned an unexpected number of ids");
    }
    chunk.forEach((path, index) => ids.set(path, lines[index]));
  }
  return ids;
}

// Index (staged) blob ids of regular files, stage 0 only.
async function indexBlobIds(repoRoot, paths) {
  const wanted = new Set(paths);
  const ids = new Map();
  // "<mode> SP <object> SP <stage> TAB <path>" per entry.
  for (const entry of splitNul(await git(repoRoot, ["ls-files", "-s", "-z"]))) {
    const tab = entry.indexOf("\t");
    const [mode, object, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (stage === "0" && REGULAR_FILE_MODES.has(mode) && wanted.has(path)) {
      ids.set(path, object);
    }
  }
  return ids;
}

// Returns the subset of `paths` (repo-relative) whose content is identical to
// the pending commit's regular-file blob at the same path. `source` is
// "worktree" (fmt, fmt:check) or "index" (pre-commit, staged content). A null
// pending exemption returns an empty set without any git call.
export async function pendingIdenticalPaths(repoRoot, paths, pending, source) {
  const identical = new Set();
  if (pending === null) {
    return identical;
  }
  const candidates = paths.filter((path) => pending.blobs.has(path));
  if (candidates.length === 0) {
    return identical;
  }
  const actual =
    source === "index"
      ? await indexBlobIds(repoRoot, candidates)
      : await worktreeBlobIds(repoRoot, candidates);
  for (const path of candidates) {
    if (actual.has(path) && actual.get(path) === pending.blobs.get(path)) {
      identical.add(path);
    }
  }
  return identical;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--fetch") {
    console.error("usage: node scripts/fork-format-pending.mjs --fetch");
    process.exitCode = 2;
  } else {
    const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).stdout.trim();
    fetchPendingUpstream(repoRoot).then(
      () => {
        console.log("fork-format: pending upstream commit available (or not declared)");
      },
      (error) => {
        console.error(`fork-format: ${error.message}`);
        process.exitCode = 1;
      },
    );
  }
}
