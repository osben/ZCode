import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import preCommitConfig from "../lint-staged.pre-commit.config.mjs";
import { FORMATTABLE_BASENAMES, FORMATTABLE_EXTENSIONS } from "./fork-format.mjs";
import { resolveToolBin } from "./run-pre-commit-checks.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wrapperPath = join(scriptDir, "run-pre-commit-checks.mjs");

// oxlint panics on explicit paths outside the repository root, so fixtures
// are created in a temporary directory under scripts/ and removed afterwards.
function makeFixtureDir() {
  return mkdtempSync(join(scriptDir, ".tmp-pre-commit-"));
}

function runWrapper(files) {
  return spawnSync(process.execPath, [wrapperPath, ...files], {
    encoding: "utf8",
  });
}

test("resolveToolBin resolves an existing bin script for both tools", () => {
  for (const packageName of ["oxlint", "oxfmt"]) {
    const binPath = resolveToolBin(packageName);
    assert.equal(isAbsolute(binPath), true);
    assert.equal(existsSync(binPath), true);
  }
});

test("resolveToolBin reports a missing bin instead of returning a bad path", () => {
  assert.throws(() => resolveToolBin("node:child_process"), Error);
});

test("an error-severity finding blocks, even when the filename matches the zero-targets phrase", () => {
  const dir = makeFixtureDir();
  try {
    const contrived = join(dir, "No files found to lint.ts");
    const lines = Array.from(
      { length: 401 },
      (_, index) => `export const probe${index} = ${index};`,
    );
    writeFileSync(contrived, `${lines.join("\n")}\n`);

    const result = runWrapper([contrived]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /max-lines/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a JSON-only set passes and is formatted in place", () => {
  const dir = makeFixtureDir();
  try {
    const fixture = join(dir, "data.json");
    writeFileSync(fixture, '{"b":2,"a":1}');

    const result = runWrapper([fixture]);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(fixture, "utf8").includes('{ "b": 2, "a": 1 }'), true);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// Same matcher and options lint-staged 17 uses in lib/matchFiles.js, loaded
// from lint-staged's own dependency tree so the test tracks its version.
function lintStagedMatcher(pattern) {
  const requireFromLintStaged = createRequire(
    createRequire(import.meta.url).resolve("lint-staged/package.json"),
  );
  const picomatch = requireFromLintStaged("picomatch");
  return picomatch(pattern, {
    dot: true,
    matchBase: !pattern.includes("/"),
    posixSlashes: true,
    strictBrackets: true,
  });
}

test("the pre-commit glob matches every file type fmt:check covers, at any depth", () => {
  const globs = Object.keys(preCommitConfig);
  assert.equal(globs.length, 1);
  const isMatch = lintStagedMatcher(globs[0]);

  const names = [
    ...FORMATTABLE_EXTENSIONS.map((extension) => `file.${extension}`),
    ...FORMATTABLE_BASENAMES,
  ];
  for (const name of names) {
    for (const path of [name, `a/b/${name}`]) {
      assert.equal(isMatch(path), true, `pre-commit glob should match ${path}`);
    }
  }
  for (const path of ["script.sh", "image.png", "Makefile", "a/b/.npmrc"]) {
    assert.equal(isMatch(path), false, `pre-commit glob should not match ${path}`);
  }
});

test("a staged YAML-only set passes oxlint and is formatted in place", () => {
  const dir = makeFixtureDir();
  try {
    const fixture = join(dir, "workflow.yml");
    writeFileSync(fixture, "on:   push\nname:   'ci'\n");

    const result = runWrapper([fixture]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(readFileSync(fixture, "utf8"), 'on: push\nname: "ci"\n');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// Hooks inject GIT_DIR/GIT_WORK_TREE and GIT_INDEX_FILE; strip them so the
// fixture repository below is the one git operates on.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

// Fixture repository whose pendingUpstreamCommit is its first commit, which
// holds pending-same.json. The fixture lives under scripts/ like the other
// fixtures, so oxlint sees paths inside its own root.
function makePendingHookFixture(pendingUpstreamCommit) {
  const dir = makeFixtureDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "pending-same.json"), '{"b":2,"a":1}');
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "pending upstream");
  const pending = git(dir, "rev-parse", "HEAD");
  const pin = { upstreamCommit: pending, pendingUpstreamCommit: pendingUpstreamCommit ?? pending };
  writeFileSync(join(dir, "fork-upstream-base.json"), `${JSON.stringify(pin, null, 2)}\n`);
  return dir;
}

function runWrapperIn(cwd, files) {
  return spawnSync(process.execPath, [wrapperPath, ...files], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  });
}

test("pre-commit does not reformat a staged file byte-identical to the pending blob, but formats the rest", () => {
  const dir = makePendingHookFixture();
  try {
    writeFileSync(join(dir, "other-fork.json"), '{"b":2,"a":1}');
    git(dir, "add", "pending-same.json", "other-fork.json");

    const result = runWrapperIn(dir, [
      join(dir, "pending-same.json"),
      join(dir, "other-fork.json"),
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(readFileSync(join(dir, "pending-same.json"), "utf8"), '{"b":2,"a":1}');
    assert.equal(
      readFileSync(join(dir, "other-fork.json"), "utf8").includes('{ "b": 2, "a": 1 }'),
      true,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("pre-commit fails loudly when the pending commit is not in the clone", () => {
  const dir = makePendingHookFixture("1".repeat(40));
  try {
    writeFileSync(join(dir, "other-fork.json"), '{"b":2,"a":1}');
    git(dir, "add", "other-fork.json");

    const result = runWrapperIn(dir, [join(dir, "other-fork.json")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /git fetch upstream/);
    assert.equal(readFileSync(join(dir, "other-fork.json"), "utf8"), '{"b":2,"a":1}');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
