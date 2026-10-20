import assert from "node:assert/strict";
import test from "node:test";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";
import { parseArgs } from "../run-affected-unit-tests.mjs";

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
