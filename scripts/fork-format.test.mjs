import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM_BASE_FILE,
  chunkPaths,
  isFormattable,
  listForkChangedFiles,
  resolveUpstreamBase,
} from "./fork-format.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "fork-format.mjs");

// Hooks inject GIT_DIR/GIT_WORK_TREE; without stripping them, git commands for
// the fixture repositories would hit the real repository instead.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

const UNFORMATTED_TS = "export const a = {b:1}\n";
const FORMATTED_TS = "export const a = { b: 1 };\n";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

function write(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function pin(repo, sha) {
  write(repo, UPSTREAM_BASE_FILE, `${JSON.stringify({ upstreamCommit: sha })}\n`);
}

// Fixture: an "upstream" commit with unformatted files, then a fork commit
// that pins it. Returns the repository path and the upstream SHA.
function makeFixtureRepo(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fork-format-")));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, "upstream-untouched.ts", UNFORMATTED_TS);
  write(repo, "upstream-edited.ts", UNFORMATTED_TS);
  write(repo, "upstream-reverted.ts", UNFORMATTED_TS);
  write(repo, "upstream-moved.ts", UNFORMATTED_TS);
  write(repo, "upstream-deleted.ts", UNFORMATTED_TS);
  const base = commitAll(repo, "upstream");
  pin(repo, base);
  commitAll(repo, "fork: pin upstream base");
  return { repo, base };
}

function runScript(repo, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repo,
    env: gitEnv,
    encoding: "utf8",
  });
}

test("isFormattable keeps oxfmt-handled extensions and known extensionless JSON names", () => {
  for (const path of ["a.ts", "dir/b.tsx", "c.MJS", "d.md", "e.yaml", "f.json", "g/.prettierrc"]) {
    assert.equal(isFormattable(path), true, path);
  }
  for (const path of ["a.png", "b.sh", "Dockerfile", ".nvmrc", "c.txt", "d.map", "e.patch"]) {
    assert.equal(isFormattable(path), false, path);
  }
});

test("chunkPaths keeps every chunk under the budget and preserves order", () => {
  const paths = Array.from({ length: 50 }, (_, index) => `dir/file-${index}.ts`);
  const chunks = chunkPaths(paths, 100);
  assert.deepEqual(chunks.flat(), paths);
  for (const chunk of chunks) {
    assert.ok(chunk.join(" ").length <= 100);
  }
  assert.deepEqual(chunkPaths([], 100), []);
  // A single path longer than the budget still gets its own chunk.
  assert.deepEqual(chunkPaths(["x".repeat(200)], 100), [["x".repeat(200)]]);
});

test("selection covers fork changes only: committed, staged, unstaged, untracked, renamed", async (t) => {
  const { repo, base } = makeFixtureRepo(t);
  write(repo, "upstream-edited.ts", `${UNFORMATTED_TS}export const c = 2\n`);
  write(repo, "upstream-reverted.ts", `${UNFORMATTED_TS}// fork edit\n`);
  write(repo, "fork-added.ts", UNFORMATTED_TS);
  git(repo, "mv", "upstream-moved.ts", "fork-moved.ts");
  write(repo, "fork-moved.ts", `${UNFORMATTED_TS}// moved\n`);
  git(repo, "rm", "-q", "upstream-deleted.ts");
  commitAll(repo, "fork changes");
  write(repo, "upstream-reverted.ts", UNFORMATTED_TS);
  commitAll(repo, "fork: revert edit");

  write(repo, "staged.ts", UNFORMATTED_TS);
  git(repo, "add", "staged.ts");
  write(repo, "fork-added.ts", `${UNFORMATTED_TS}// unstaged\n`);
  write(repo, "untracked.md", "# t\n");
  write(repo, "ignored.ts", UNFORMATTED_TS);
  write(repo, ".gitignore", "ignored.ts\n");
  write(repo, "image.png", "not-formattable");

  const files = await listForkChangedFiles(repo, base);
  assert.deepEqual(files, [
    "fork-added.ts",
    "fork-moved.ts",
    UPSTREAM_BASE_FILE,
    "staged.ts",
    "untracked.md",
    "upstream-edited.ts",
  ]);
});

test("fmt:check fails on an unformatted fork file and fmt fixes only fork files", (t) => {
  const { repo } = makeFixtureRepo(t);
  write(repo, "fork-added.ts", UNFORMATTED_TS);
  commitAll(repo, "fork: add unformatted file");

  const failing = runScript(repo, "--check");
  assert.notEqual(failing.status, 0, failing.stdout + failing.stderr);
  assert.match(failing.stdout + failing.stderr, /fork-added\.ts/);

  const fixing = runScript(repo);
  assert.equal(fixing.status, 0, fixing.stdout + fixing.stderr);
  assert.equal(readFileSync(join(repo, "fork-added.ts"), "utf8"), FORMATTED_TS);
  assert.equal(readFileSync(join(repo, "upstream-untouched.ts"), "utf8"), UNFORMATTED_TS);

  const passing = runScript(repo, "--check");
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
});

test("base resolution fails loudly on a missing, malformed, unknown or non-ancestor pin", async (t) => {
  const { repo, base } = makeFixtureRepo(t);

  rmSync(join(repo, UPSTREAM_BASE_FILE));
  await assert.rejects(resolveUpstreamBase(repo), /fork-upstream-base\.json/);

  write(repo, UPSTREAM_BASE_FILE, '{"upstreamCommit":"main"}');
  await assert.rejects(resolveUpstreamBase(repo), /40-character/);

  pin(repo, "0".repeat(40));
  await assert.rejects(resolveUpstreamBase(repo), /fetch-depth: 0/);

  const emptyTree = execFileSync("git", ["mktree"], { cwd: repo, env: gitEnv, input: "" })
    .toString()
    .trim();
  const unrelated = git(repo, "commit-tree", emptyTree, "-m", "unrelated root");
  pin(repo, unrelated);
  await assert.rejects(resolveUpstreamBase(repo), /not an ancestor of HEAD/);

  pin(repo, base);
  assert.equal(await resolveUpstreamBase(repo), base);
  assert.equal(runScript(repo, "--list").status, 0);
});

test("base resolution rejects a pin that disagrees with merge-base HEAD upstream/main", async (t) => {
  const { repo, base } = makeFixtureRepo(t);
  // Simulate a merged upstream sync whose pin was not bumped.
  git(repo, "checkout", "-q", "-b", "upstream-next", base);
  write(repo, "upstream-new.ts", UNFORMATTED_TS);
  const next = commitAll(repo, "upstream next");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-edit", "upstream-next");
  git(repo, "update-ref", "refs/remotes/upstream/main", next);

  await assert.rejects(resolveUpstreamBase(repo), /stale/);
  const result = runScript(repo, "--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale/);

  pin(repo, next);
  assert.equal(await resolveUpstreamBase(repo), next);
  assert.equal((await listForkChangedFiles(repo, next)).includes("upstream-new.ts"), false);
});
