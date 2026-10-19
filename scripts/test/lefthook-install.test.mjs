import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixture, repoRoot } from "./lefthook-fixture.mjs";

const exec = promisify(execFile);

test("migration in a linked worktree preserves sibling hooks and shared configuration", async (t) => {
  const f = await fixture(t, { legacy: true });
  await f.install();
  const hook = join(f.root, ".husky/_/pre-commit");
  const original = await readFile(hook, "utf8");
  const config = await readFile(join(f.root, ".git/config"), "utf8");
  const linked = join(f.root, "linked");
  await f.git("worktree", "add", "--quiet", "-b", "feature", linked);
  await exec(process.execPath, [join(repoRoot, "scripts/install-git-hooks.mjs")], {
    cwd: linked,
    env: f.env,
  });
  assert.equal(await readFile(hook, "utf8"), original);
  assert.equal(await readFile(join(f.root, ".git/config"), "utf8"), config);
  const padding = Array.from({ length: 20 }, (_, i) => `  "p${i}": ${i},`).join("\n");
  const staged = `{\n  "staged":1,\n${padding}\n  "unstaged": 0\n}\n`;
  await writeFile(join(linked, "tracked.json"), staged);
  await exec("git", ["add", "tracked.json"], { cwd: linked, env: f.env });
  await writeFile(join(linked, "tracked.json"), staged.replace('"unstaged": 0', '"unstaged": 2'));
  await exec("git", ["commit", "-m", "partial worktree commit"], { cwd: linked, env: f.env });
  const committed = JSON.parse(
    (await exec("git", ["show", "HEAD:tracked.json"], { cwd: linked, env: f.env })).stdout,
  );
  assert.equal(committed.staged, 1);
  assert.equal(committed.unstaged, 0);
  assert.match(await readFile(join(linked, "tracked.json"), "utf8"), /"unstaged"\s*:\s*2/u);
  assert.equal(await f.git("show", "HEAD:tracked.json"), '{ "staged": 0 }');
});

test("an unrelated custom hooks directory is refused without overwriting hooks", async (t) => {
  const f = await fixture(t);
  await f.put("custom-hooks/pre-commit", "keep this hook\n");
  await f.git("config", "core.hooksPath", "custom-hooks");
  await assert.rejects(f.install());
  assert.equal(await readFile(join(f.root, "custom-hooks/pre-commit"), "utf8"), "keep this hook\n");
  assert.equal(await f.git("config", "core.hooksPath"), "custom-hooks");
});
