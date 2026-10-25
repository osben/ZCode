import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixture } from "./lefthook-fixture.mjs";

const exec = promisify(execFile);

test("real pushes forward refs, clean Git-local environment and preserve failures", async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, "bin");
  await mkdir(bin);
  const capture = join(f.root, "capture.mjs");
  await writeFile(
    capture,
    `import { writeFile } from 'node:fs/promises';
await writeFile('captured.json', JSON.stringify({
  refs: process.env.ZCODE_PRE_PUSH_STDIN,
  gitDir: process.env.GIT_DIR,
  gitWorkTree: process.env.GIT_WORK_TREE,
  gitIndex: process.env.GIT_INDEX_FILE,
  args: process.argv.slice(2),
}));
process.exit(process.env.FAIL_PUSH === '1' ? 7 : 0);
`,
  );
  await writeFile(join(bin, "pnpm"), '#!/bin/sh\nexec node capture.mjs "$@"\n', { mode: 0o755 });
  f.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${f.env.PATH}`;
  await f.install();
  const remote = join(f.root, "remote.git");
  await exec("git", ["init", "--bare", "--quiet", remote], { env: f.env });
  await f.git("remote", "add", "origin", remote);
  const head = await f.git("rev-parse", "HEAD");
  await exec("git", ["push", "-u", "origin", "main"], { cwd: f.root, env: f.env });
  let captured = JSON.parse(await readFile(join(f.root, "captured.json"), "utf8"));
  assert.equal(captured.refs, `refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}`);
  assert.deepEqual(captured.args, ["run", "verify:pre-push"]);
  assert.equal(captured.gitDir, undefined);
  assert.equal(captured.gitWorkTree, undefined);
  assert.equal(captured.gitIndex, undefined);
  await f.put("tracked.json", '{ "staged": 2 }\n');
  await f.git("add", "tracked.json");
  const committed = await f.commit();
  assert.equal(committed.code, 0, committed.stdout + committed.stderr);
  const next = await f.git("rev-parse", "HEAD");
  await assert.rejects(
    exec("git", ["push", "origin", "main"], { cwd: f.root, env: { ...f.env, FAIL_PUSH: "1" } }),
  );
  captured = JSON.parse(await readFile(join(f.root, "captured.json"), "utf8"));
  assert.equal(captured.refs, `refs/heads/main ${next} refs/heads/main ${head}`);
  assert.match(
    (await exec("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: f.root, env: f.env }))
      .stdout,
    new RegExp(`^${head}\\s`, "u"),
  );
});
