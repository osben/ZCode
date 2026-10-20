import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const runner = fileURLToPath(new URL("../run-pre-push.mjs", import.meta.url));
const zeroSha = "0".repeat(40);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-pre-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "repo"));
  const root = await realpath(join(dir, "repo"));
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  await git("init", "--initial-branch=integration");
  await git("config", "user.name", "Pre-push Test");
  await git("config", "user.email", "pre-push@example.invalid");
  await git("config", "commit.gpgsign", "false");
  const put = async (path, contents = "content\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  };
  await put("README.md");
  await put("packages/example/src/index.ts", "export const value = 1;\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  const base = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/integration", base);
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/integration");
  const callsPath = join(dir, "calls.jsonl");
  const pnpmCli = join(dir, "pnpm.mjs");
  await writeFile(
    pnpmCli,
    `import { appendFile } from 'node:fs/promises';
await appendFile(process.env.CALLS_PATH, JSON.stringify({
  args: process.argv.slice(2),
  cache: process.env.NODE_COMPILE_CACHE,
  disabled: process.env.NODE_DISABLE_COMPILE_CACHE,
  affectedBase: process.env.ZCODE_AFFECTED_TEST_BASE,
}) + '\\n');
if (process.env.FAIL_STAGE && process.argv[3] === process.env.FAIL_STAGE) process.exit(7);
`,
  );
  const commit = async () => {
    await git("add", ".");
    await git("commit", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  const run = async (overrides = {}) => {
    const env = { ...process.env };
    for (const name of [
      "ZCODE_PRE_PUSH_STDIN",
      "ZCODE_PRE_PUSH_BASE",
      "ZCODE_AFFECTED_TEST_BASE",
      "NODE_COMPILE_CACHE",
      "NODE_DISABLE_COMPILE_CACHE",
    ])
      delete env[name];
    let result;
    try {
      result = await exec(process.execPath, [runner], {
        cwd: root,
        env: { ...env, npm_execpath: pnpmCli, CALLS_PATH: callsPath, ...overrides },
      });
      result.code = 0;
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      result = error;
    }
    let calls = [];
    try {
      calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rm(callsPath, { force: true });
    return { ...result, calls, stages: calls.map((call) => call.args[1]) };
  };
  return { root, git, put, base, commit, run, pnpmCli };
}

const allStages = [
  "lint",
  "test:architecture",
  "architecture:check",
  "test-copy:check",
  "test:unit:affected",
  "test:node",
];
// Documentation-only pushes run the static stages and skip both test stages.
const staticStages = allStages.slice(0, 4);

test("supports executable package managers as well as JS entry points", async (t) => {
  const f = await fixture(t);
  await f.put("README.md", "documentation change\n");
  await f.commit();
  await f.put(
    "run",
    (await readFile(f.pnpmCli, "utf8")).replace(
      "process.argv.slice(2)",
      '["run", ...process.argv.slice(2)]',
    ),
  );
  const result = await f.run({ npm_execpath: process.execPath });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stages, staticStages);
});

test("documentation-only commits run static checks and skip both test stages", async (t) => {
  const f = await fixture(t);
  await f.put("specs/example.md");
  await f.put("docs/guide.md");
  await f.commit();
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stages, staticStages);
  assert.match(result.stdout, /documentation-only.*skip/iu);
  assert.match(result.stdout, /lint.*passed.*\d+\.\d+s/u);
  assert.match(result.stdout, /total.*\d+\.\d+s/u);
  assert.deepEqual(result.calls[2].args, ["run", "architecture:check", "--", "--changed"]);
});

test("deleted documentation is safe to skip", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "README.md"));
  await f.commit();
  assert.deepEqual((await f.run()).stages, staticStages);
});

test("source, configuration, runtime Markdown, MDX and mixed changes retain tests", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "packages/example/src/index.ts",
    "package.json",
    "packages/example/prompts/instructions.md",
    "docs/interactive.mdx",
  ]) {
    await f.put(path, "changed\n");
    await f.put("docs/guide.md", path);
    const head = await f.commit();
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stages, allStages, path);
    await f.git("update-ref", "refs/remotes/origin/integration", head);
  }
});

test("renaming source into documentation cannot hide the deleted source", async (t) => {
  const f = await fixture(t);
  await f.git("mv", "packages/example/src/index.ts", "renamed.md");
  await f.commit();
  assert.deepEqual((await f.run()).stages, allStages);
});

test("existing branch pushes compare against the remote SHA supplied by Git", async (t) => {
  const f = await fixture(t);
  await f.put("packages/example/src/index.ts", "export const value = 2;\n");
  const remote = await f.commit();
  await f.put("README.md", "documentation change\n");
  const head = await f.commit();
  const result = await f.run({
    ZCODE_PRE_PUSH_STDIN: `refs/heads/feature ${head} refs/heads/feature ${remote}\n`,
  });
  assert.deepEqual(result.stages, staticStages);
});

test("new branches prefer the actual default even with a stale staging ref", async (t) => {
  const f = await fixture(t);
  await f.git("update-ref", "refs/remotes/origin/staging", f.base);
  await f.put("packages/example/src/index.ts", "export const value = 2;\n");
  const integration = await f.commit();
  await f.git("update-ref", "refs/remotes/origin/integration", integration);
  await f.put("README.md", "documentation change\n");
  const head = await f.commit();
  const result = await f.run({
    ZCODE_PRE_PUSH_STDIN: `refs/heads/feature ${head} refs/heads/feature ${zeroSha}\n`,
  });
  assert.deepEqual(result.stages, staticStages);
});

test("multiple push refs and missing targets cannot use the documentation shortcut", async (t) => {
  const f = await fixture(t);
  await f.put("README.md", "documentation change\n");
  const head = await f.commit();
  const result = await f.run({
    ZCODE_PRE_PUSH_STDIN: `refs/heads/feature ${head} refs/heads/feature ${f.base}\nrefs/heads/other ${f.base} refs/heads/other ${zeroSha}\n`,
  });
  assert.deepEqual(result.stages, allStages);
  await f.git("update-ref", "-d", "refs/remotes/origin/integration");
  assert.deepEqual((await f.run()).stages, allStages);
});

test("a failing stage preserves its status, reports timing and stops subsequent stages", async (t) => {
  const f = await fixture(t);
  await f.put("packages/example/src/index.ts", "changed\n");
  await f.commit();
  const result = await f.run({ FAIL_STAGE: "architecture:check" });
  assert.equal(result.code, 7);
  assert.deepEqual(result.stages, allStages.slice(0, 3));
  assert.match(result.stdout, /architecture:check.*failed.*7.*\d+\.\d+s/u);
  assert.match(result.stdout, /total.*\d+\.\d+s/u);
});

test("new branches pass the resolved merge-base to affected tests without origin/staging", async (t) => {
  const f = await fixture(t);
  await f.put("packages/example/src/index.ts", "changed\n");
  const head = await f.commit();
  // The fixture has no origin/staging; upstream's first-push fallback would fail here.
  const result = await f.run({
    ZCODE_PRE_PUSH_STDIN: `refs/heads/feature ${head} refs/heads/feature ${zeroSha}\n`,
  });
  assert.equal(result.code, 0, result.stderr);
  const affected = result.calls.find((call) => call.args[1] === "test:unit:affected");
  assert.equal(affected.affectedBase, f.base);
});

test("invalid comparison bases fail rather than taking the skip path", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ ZCODE_PRE_PUSH_BASE: "missing-ref" });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /documentation-only.*skip/iu);
});

test("checks reuse an ignored compile cache and preserve explicit cache settings", async (t) => {
  const f = await fixture(t);
  await f.put("README.md", "documentation change\n");
  await f.commit();
  const expectedCache = join(f.root, ".cache", "pre-push", "node-compile");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.calls.every((call) => call.cache === expectedCache));
  }
  const customCache = join(f.root, "custom-cache");
  const custom = await f.run({ NODE_COMPILE_CACHE: customCache, NODE_DISABLE_COMPILE_CACHE: "1" });
  assert.ok(custom.calls.every((call) => call.cache === customCache && call.disabled === "1"));
});
