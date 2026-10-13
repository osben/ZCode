import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hasNoTargetFiles, resolveToolBin } from "./run-pre-commit-checks.mjs";

test("hasNoTargetFiles matches only the tools' zero-targets outcomes", () => {
  assert.equal(
    hasNoTargetFiles("No files found to lint. Please check your paths and ignore patterns.\n"),
    true,
  );
  assert.equal(hasNoTargetFiles("Expected at least one target file\n"), true);
  assert.equal(hasNoTargetFiles("  x eslint(max-lines): too many lines\n"), false);
  assert.equal(hasNoTargetFiles(""), false);
});

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
