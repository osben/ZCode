import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveToolBin } from "./run-pre-commit-checks.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./check-staged-file-tokens.mjs", import.meta.url));
const hookConfig = new URL("../lefthook.yml", import.meta.url);

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
  await f.stage("other.ts", "a".repeat(24_000));
  const result = await f.check();
  assert.equal(result.code, 1);
  for (const expected of ["code.ts", "other.ts", "20001", "5000.25", "6000", "Split", "git add"]) {
    assert.ok(result.stderr.includes(expected), result.stderr);
  }
});

test("the limit counts UTF-8 bytes, not characters", async (t) => {
  const f = await fixture(t);
  await f.stage("unicode.ts", "я".repeat(10_001));
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

test("spaces, quotes, leading dashes and supported newlines in paths are safe", async (t) => {
  const f = await fixture(t);
  const names = ["-some 'odd' file.ts"];
  // Windows rejects control characters in filenames; retain newline coverage on POSIX.
  if (process.platform !== "win32") names.push("-some 'odd'\n file.ts");
  for (const name of names) await f.stage(name, "a".repeat(21_000));
  const result = await f.check();
  assert.equal(result.code, 1);
  for (const name of names) assert.ok(result.stderr.includes(JSON.stringify(name)), result.stderr);
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
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, "scripts"));
  await writeFile(path.join(f.cwd, "scripts/check-staged-file-tokens.mjs"), await readFile(script));
  // The guard imports the shared pending-upstream helper from its sibling module.
  await writeFile(
    path.join(f.cwd, "scripts/fork-format-pending.mjs"),
    await readFile(new URL("./fork-format-pending.mjs", import.meta.url)),
  );
  const config = (await readFile(hookConfig, "utf8")).replace(
    "pnpm exec lint-staged --config lint-staged.pre-commit.config.mjs",
    "node scripts/fake-formatter.mjs",
  );
  const wrapper = fileURLToPath(new URL("./run-lefthook.mjs", import.meta.url)).replaceAll(
    "\\",
    "/",
  );
  const quotedWrapper = `'${wrapper.replaceAll("'", "'\\''")}'`;
  await writeFile(
    path.join(f.cwd, "lefthook.yml"),
    config.replace("node scripts/run-lefthook.mjs", `node ${quotedWrapper}`),
  );
  await writeFile(
    path.join(f.cwd, "scripts/fake-formatter.mjs"),
    `
import { writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await writeFile('formatter-ran', 'ran\\n');
await copyFile('formatted.txt', 'code.ts');
execFileSync('git', ['add', '--', 'code.ts']);
`,
  );
  await exec(process.execPath, [resolveToolBin("lefthook"), "install"], { cwd: f.cwd });
  await f.stage("code.ts", "small");
  await writeFile(path.join(f.cwd, "formatted.txt"), "a".repeat(21_000));
  const bin = fileURLToPath(new URL("../node_modules/.bin/", import.meta.url));
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

// Pending-upstream fixture: commit A holds an oversized file at `notes/upstream.ts`
// and is the pending commit; the fork then changes it. The caller decides what
// is staged afterwards.
async function pendingSizeFixture(t, { stagePin = true } = {}) {
  const f = await fixture(t);
  await f.git("config", "user.email", "test@example.com");
  await f.git("config", "user.name", "Test");
  await f.git("config", "commit.gpgsign", "false");
  const upstream = "a".repeat(21_000);
  await f.stage("notes/upstream.ts", upstream);
  await f.git("commit", "--quiet", "-m", "pending upstream");
  const pending = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.stage("notes/upstream.ts", "small fork version");
  await f.git("commit", "--quiet", "-m", "fork");
  await writeFile(
    path.join(f.cwd, "fork-upstream-base.json"),
    `${JSON.stringify({ upstreamCommit: pending, pendingUpstreamCommit: pending }, null, 2)}\n`,
  );
  if (stagePin) await f.git("add", "--", "fork-upstream-base.json");
  return { ...f, upstream, pending };
}

test("an oversize staged blob identical to the pending commit passes the size guard", async (t) => {
  const f = await pendingSizeFixture(t);
  await f.stage("notes/upstream.ts", f.upstream);
  assert.equal((await f.check()).code, 0);
});

test("an oversize staged blob that differs from the pending commit by one byte still blocks", async (t) => {
  const f = await pendingSizeFixture(t);
  await f.stage("notes/upstream.ts", `${f.upstream}\n`);
  const result = await f.check();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /notes\/upstream\.ts/);
});

test("the size guard ignores an unstaged pin: an identical blob still blocks", async (t) => {
  const f = await pendingSizeFixture(t, { stagePin: false });
  await f.stage("notes/upstream.ts", f.upstream);
  assert.equal((await f.check()).code, 1);
});

test("a staged file listed in the exemptions file may exceed the limit", async (t) => {
  const f = await fixture(t);
  await f.stage("locale.ts", "a".repeat(20_001));
  assert.equal((await f.check()).code, 1);
  await writeFile(
    path.join(f.cwd, ".staged-file-size-exemptions"),
    "# generated catalog\nlocale.ts # trailing comment\n",
  );
  await f.git("add", "--", ".staged-file-size-exemptions");
  assert.equal((await f.check()).code, 0);
});

test("markdown files are never size-limited, at any depth and in any case", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "notes.md",
    "docs/guide/big.md",
    "specs/huge-SPEC.MD",
    "packages/ui/src/readme.md",
  ]) {
    await f.stage(name, "a".repeat(40_000));
  }
  assert.equal((await f.check()).code, 0);
});

test("test files are never size-limited", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "packages/ui/src/feature.test.ts",
    "packages/ui/src/view.spec.tsx",
    "scripts/tool.test.mjs",
    "scripts/tool.test.cjs",
    "lib/a.test.mts",
    "lib/a.test.cts",
    "lib/a.test.js",
    "lib/a.test.jsx",
    "packages/ui/test/helper.ts",
    "packages/desktop/test/e2e/flow.ts",
    "apps/x/tests/data.ts",
    "packages/web/__tests__/render.tsx",
    "packages/desktop/e2e/login.ts",
  ]) {
    await f.stage(name, "a".repeat(21_000));
  }
  assert.equal((await f.check()).code, 0);
});

test("source, script and config files stay guarded, including test-like names", async (t) => {
  const f = await fixture(t);
  const names = [
    "packages/ui/src/feature.ts",
    "docs/guide/code.ts",
    "packages/ui/src/testing-utils.ts",
    "packages/ui/src/contest/index.ts",
    "packages/ui/src/attest/index.ts",
    "packages/ui/src/latest.ts",
    "packages/ui/src/test.ts",
    "scripts/check.mjs",
    "config/app.json",
    "notes.mdx",
    "notes.txt",
  ];
  for (const name of names) await f.stage(name, "a".repeat(21_000));
  const result = await f.check();
  assert.equal(result.code, 1);
  for (const name of names) assert.ok(result.stderr.includes(JSON.stringify(name)), result.stderr);
});
