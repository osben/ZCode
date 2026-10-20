import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";
import { parseArgs } from "../run-affected-unit-tests.mjs";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("../run-affected-unit-tests.mjs", import.meta.url));
const repoNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));

test("prefers origin/staging as the default affected-test baseline", () => {
  const availableRefs = new Set(["origin/staging", "origin/main"]);

  const selected = selectDefaultBranchRef({
    originHead: "origin/main",
    hasCommit: (ref) => availableRefs.has(ref),
  });

  assert.equal(selected, "origin/staging");
});

test("parseArgs accepts --on-full run and skip", async () => {
  assert.equal((await parseArgs(["--on-full", "run"])).onFull, "run");
  assert.equal((await parseArgs(["--on-full", "skip"])).onFull, "skip");
});

test("parseArgs leaves onFull unset by default so pre-push keeps the full-suite skip", async () => {
  assert.equal((await parseArgs([])).onFull, undefined);
  assert.equal((await parseArgs(["--base", "HEAD"])).onFull, undefined);
});

test("parseArgs rejects missing and invalid --on-full values", async () => {
  await assert.rejects(() => parseArgs(["--on-full"]), /--on-full 需要参数/u);
  await assert.rejects(() => parseArgs(["--on-full", "--dry-run"]), /--on-full 需要参数/u);
  await assert.rejects(() => parseArgs(["--on-full", "always"]), /只接受 run 或 skip：always/u);
});

// The fixture repo contains exactly one Vitest spec, so passing that file to --files makes the
// official selection cover the whole suite — the same state CI reaches for large PRs, where the
// entrypoint must execute (not skip) and propagate failures. node_modules is a junction to the
// repository's install so the spec can import Vitest without a second dependency tree.
async function fullSelectionFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-affected-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "repo"));
  const root = await realpath(join(dir, "repo"));
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "--initial-branch=integration");
  await git("config", "user.name", "Affected Test");
  await git("config", "user.email", "affected@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await symlink(repoNodeModules, join(root, "node_modules"), "junction");
  await writeFile(join(root, "README.md"), "baseline\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  const put = (path, contents) => writeFile(join(root, path), contents);
  const run = async (args) => {
    const env = { ...process.env };
    for (const name of ["ZCODE_PRE_PUSH_STDIN", "ZCODE_PRE_PUSH_BASE", "ZCODE_AFFECTED_TEST_BASE"])
      delete env[name];
    try {
      const result = await exec(process.execPath, [runner, ...args], { cwd: root, env });
      result.code = 0;
      return result;
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return error;
    }
  };
  return { put, run };
}

test("full selection with --on-full run executes the suite instead of skipping", async (t) => {
  const f = await fullSelectionFixture(t);
  await f.put("demo.test.mjs", 'import { test } from "vitest";\ntest("demo", () => {});\n');
  const result = await f.run(["--files", "demo.test.mjs", "--on-full", "run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /选中 1\/1/u);
  assert.match(result.stderr, /--on-full run：执行全量/u);
  assert.doesNotMatch(result.stderr, /已跳过 UT/u);
  assert.match(result.stdout, /Test Files\s+1 passed/u);
});

test("full selection with --on-full run propagates test failures", async (t) => {
  const f = await fullSelectionFixture(t);
  await f.put(
    "demo.test.mjs",
    'import { test } from "vitest";\ntest("demo", () => {\n  throw new Error("boom");\n});\n',
  );
  const result = await f.run(["--files", "demo.test.mjs", "--on-full", "run"]);
  assert.equal(result.code, 1);
});

test("full selection without --on-full still skips and exits zero", async (t) => {
  const f = await fullSelectionFixture(t);
  await f.put("demo.test.mjs", 'import { test } from "vitest";\ntest("demo", () => {});\n');
  const result = await f.run(["--files", "demo.test.mjs"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /已跳过 UT（未执行测试）/u);
  assert.doesNotMatch(result.stderr, /执行全量/u);
});
