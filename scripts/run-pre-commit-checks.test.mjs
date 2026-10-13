import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
