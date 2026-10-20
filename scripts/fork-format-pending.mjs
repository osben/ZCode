// Git plumbing shared by scripts/fork-format.mjs (pnpm fmt / fmt:check) and
// scripts/run-pre-commit-checks.mjs (pre-commit): the pending-upstream
// exemption from specs/fork-format-scope.md, plus helpers for batched git
// calls. Both callers must drop the same files, so the comparison lives here.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UPSTREAM_BASE_FILE = "fork-upstream-base.json";

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

// Reads the optional pendingUpstreamCommit field. Returns null when the key is
// absent (the exemption is off); otherwise the commit and a Map from path to
// blob id for the regular files of that commit.
export async function loadPendingUpstream(repoRoot) {
  let raw;
  try {
    raw = await readFile(join(repoRoot, UPSTREAM_BASE_FILE), "utf8");
  } catch (error) {
    throw new Error(`cannot read ${UPSTREAM_BASE_FILE}: ${error.message}`);
  }
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
  if (!(await gitSucceeds(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]))) {
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

// Working-tree blob ids, hashed without clean filters so the comparison is on
// raw bytes. `git hash-object` prints one line per file, in argument order.
async function worktreeBlobIds(repoRoot, paths) {
  const ids = new Map();
  for (const chunk of chunkPaths(paths)) {
    const lines = (await git(repoRoot, ["hash-object", "--no-filters", "--", ...chunk])).split(
      "\n",
    );
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

// Returns the subset of `paths` (repo-relative) whose content is byte-identical
// to the pending commit's regular-file blob at the same path. `source` is
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
