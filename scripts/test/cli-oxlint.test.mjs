import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runOxlint } from "../cli-oxlint.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cli-oxlint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "apps/zcode-cli");
  const cwd = join(workspace, "packages/example");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "package.json"), '{"name":"example"}\n');
  // A nested workspace manifest makes `pnpm exec` run its own verify-deps install here.
  await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  return { root, workspace, cwd };
}

async function fakeOxlint(directory, { version, exitCode = 0 }) {
  const pkg = join(directory, "node_modules/oxlint");
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "oxlint", version, bin: { oxlint: "bin/oxlint" } }),
  );
  await writeFile(
    join(pkg, "bin/oxlint"),
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), cwd: process.cwd() }));
process.exitCode = ${exitCode};
`,
  );
}

test("runs the package-resolved oxlint without going through npm_execpath", async (t) => {
  const f = await fixture(t);
  await fakeOxlint(f.root, { version: "1.0.0" });
  await fakeOxlint(f.workspace, { version: "2.0.0" });
  const saved = process.env.npm_execpath;
  t.after(() => {
    if (saved === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = saved;
  });
  // pnpm 11+ ships as a native executable; running it through node used to fail with a SyntaxError.
  process.env.npm_execpath = process.platform === "win32" ? "C:\\pnpm.exe" : "/bin/sh";
  const result = await runOxlint(f.cwd, ["src", "--format", "json"]);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, "2.0.0");
  assert.deepEqual(output.args, ["src", "--format", "json"]);
  assert.equal(output.cwd, await realpath(f.cwd));
});

test("returns oxlint's diagnostic exit instead of throwing", async (t) => {
  const f = await fixture(t);
  await fakeOxlint(f.cwd, { version: "3.0.0", exitCode: 1 });
  const result = await runOxlint(f.cwd, []);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).version, "3.0.0");
});

test("names the package directory when oxlint is not installed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runOxlint(f.cwd, []), (error) => error.message.includes(f.cwd));
});
