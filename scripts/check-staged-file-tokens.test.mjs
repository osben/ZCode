import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./check-staged-file-tokens.mjs", import.meta.url));
const hook = new URL("../.husky/pre-commit", import.meta.url);

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "zcode-token-gate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => exec("git", args, { cwd });
  await git("init", "--quiet");
  // Keep disposable repositories independent of the user's global attributes.
  const emptyAttributes = path.join(cwd, "empty-attributes");
  await writeFile(emptyAttributes, "");
  await git("config", "core.attributesFile", emptyAttributes);
  await git("config", "core.autocrlf", "false");
  const stage = async (name, content) => {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), content);
    await git("add", "--", name);
  };
  const check = async () => {
    try {
      const result = await exec(process.execPath, [script], { cwd });
      return { code: 0, ...result };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { cwd, git, stage, check };
}

test("an empty index and exactly 20,000 staged bytes pass without HEAD", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.check()).code, 0);
  await f.stage("code.ts", "a".repeat(20_000));
  assert.equal((await f.check()).code, 0);
});

test("oversize files report every path, byte count, tokens and split instructions", async (t) => {
  const f = await fixture(t);
  await f.stage("code.ts", "a".repeat(20_001));
  await f.stage("notes.md", "a".repeat(24_000));
  const result = await f.check();
  assert.equal(result.code, 1);
  for (const expected of ["code.ts", "notes.md", "20001", "5000.25", "6000", "Split", "git add"]) {
    assert.ok(result.stderr.includes(expected), result.stderr);
  }
});

test("the limit counts UTF-8 bytes, not characters", async (t) => {
  const f = await fixture(t);
  await f.stage("unicode.md", "я".repeat(10_001));
  const result = await f.check();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /20002/);
});

test("a larger unstaged working copy is ignored", async (t) => {
  const f = await fixture(t);
  await f.stage("code.ts", "small");
  await writeFile(path.join(f.cwd, "code.ts"), "a".repeat(21_000));
  assert.equal((await f.check()).code, 0);
});

test("a smaller or deleted working copy cannot hide an oversize staged blob", async (t) => {
  const f = await fixture(t);
  await f.stage("code.ts", "a".repeat(21_000));
  await writeFile(path.join(f.cwd, "code.ts"), "small");
  assert.equal((await f.check()).code, 1);
  await rm(path.join(f.cwd, "code.ts"));
  assert.equal((await f.check()).code, 1);
});

test("lock files and generated names are exempt, ordinary JSON is checked", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "pnpm-lock.yaml",
    "nested/package-lock.json",
    "schema.generated.ts",
    "api.gen.ts",
  ]) {
    await f.stage(name, "a".repeat(21_000));
  }
  assert.equal((await f.check()).code, 0);
  await f.stage("not.generated.code/data.json", "a".repeat(21_000));
  assert.equal((await f.check()).code, 1);
});

test("generated and vendored attributes use the index rather than unstaged edits", async (t) => {
  const f = await fixture(t);
  await f.stage(
    ".gitattributes",
    "output.ts linguist-generated=true\nvendor.ts linguist-vendored\n",
  );
  await f.stage("output.ts", "a".repeat(21_000));
  await f.stage("vendor.ts", "a".repeat(21_000));
  await writeFile(path.join(f.cwd, ".gitattributes"), "");
  assert.equal((await f.check()).code, 0);
  await f.stage(
    ".gitattributes",
    "output.ts -linguist-generated\nvendor.ts linguist-vendored=false\n",
  );
  await writeFile(path.join(f.cwd, ".gitattributes"), "* linguist-generated=true\n");
  assert.equal((await f.check()).code, 1);
});

test("spaces, newlines, quotes and leading dashes in paths are safe", async (t) => {
  const f = await fixture(t);
  const name = "-some 'odd'\n file.ts";
  await f.stage(name, "a".repeat(21_000));
  const result = await f.check();
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(JSON.stringify(name)), result.stderr);
});

test("only staged changes are checked; renames block and deletions pass", async (t) => {
  const f = await fixture(t);
  await f.stage("existing.ts", "a".repeat(21_000));
  // Build a baseline without creating a commit or triggering real repository hooks.
  const { stdout: tree } = await f.git("write-tree");
  const { stdout: commit } = await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      tree.trim(),
      "-m",
      "fixture",
    ],
    { cwd: f.cwd },
  );
  await f.git("update-ref", "HEAD", commit.trim());
  assert.equal((await f.check()).code, 0);
  await f.git("mv", "existing.ts", "renamed.ts");
  assert.equal((await f.check()).code, 1);
  await f.git("rm", "--cached", "renamed.ts");
  assert.equal((await f.check()).code, 0);
});

test("symbolic links are not inspected as regular file content", async (t) => {
  if (process.platform === "win32") return t.skip("Requires symlink privileges on Windows");
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "untracked.ts"), "a".repeat(21_000));
  await symlink("untracked.ts", path.join(f.cwd, "link.ts"));
  await f.git("add", "link.ts");
  assert.equal((await f.check()).code, 0);
});

test("Git errors fail closed", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.cwd, ".git"), { recursive: true });
  const result = await f.check();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unable to check staged files/);
});

test("the actual hook rechecks the index after formatter changes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX Husky hook");
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, "scripts"));
  await writeFile(path.join(f.cwd, "scripts/check-staged-file-tokens.mjs"), await readFile(script));
  await mkdir(path.join(f.cwd, ".husky"));
  await writeFile(path.join(f.cwd, ".husky/pre-commit"), await readFile(hook), { mode: 0o755 });
  await f.git("config", "core.hooksPath", ".husky");
  await f.stage("code.ts", "small");
  await writeFile(path.join(f.cwd, "formatted.txt"), "a".repeat(21_000));
  const bin = path.join(f.cwd, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "pnpm"),
    "#!/bin/sh\necho ran > formatter-ran\ncp formatted.txt code.ts\ngit add -- code.ts\n",
    { mode: 0o755 },
  );
  const runHook = () =>
    exec("git", ["hook", "run", "pre-commit"], {
      cwd: f.cwd,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
  await f.stage("code.ts", "a".repeat(21_000));
  await assert.rejects(runHook(), (error) => error.code === 1 && /21000/.test(error.stderr));
  await assert.rejects(readFile(path.join(f.cwd, "formatter-ran")), { code: "ENOENT" });
  await f.stage("code.ts", "small");
  await assert.rejects(runHook(), (error) => error.code === 1 && /21000/.test(error.stderr));
  assert.equal(await readFile(path.join(f.cwd, "formatter-ran"), "utf8"), "ran\n");
});
