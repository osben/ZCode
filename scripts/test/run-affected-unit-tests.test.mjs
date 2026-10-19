import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";

test("prefers the actual default branch over a stale staging ref", () => {
  const availableRefs = new Set(["origin/staging", "origin/integration", "origin/main"]);

  const selected = selectDefaultBranchRef({
    originHead: "origin/integration",
    hasCommit: (ref) => availableRefs.has(ref),
  });

  assert.equal(selected, "origin/integration");
});

test("prefers integration when origin/HEAD is unavailable", () => {
  const availableRefs = new Set(["origin/staging", "origin/integration", "origin/main"]);
  assert.equal(
    selectDefaultBranchRef({ hasCommit: (ref) => availableRefs.has(ref) }),
    "origin/integration",
  );
});

test("retains the default branch and legacy fallbacks", () => {
  for (const ref of ["origin/main", "origin/staging", "origin/master", "main", "master"]) {
    assert.equal(
      selectDefaultBranchRef({ originHead: "origin/main", hasCommit: (value) => value === ref }),
      ref,
    );
  }
  assert.equal(selectDefaultBranchRef({ hasCommit: () => false }), undefined);
});

test("does not force a full unit run based on changed file names", async () => {
  const runnerSource = await readFile(
    new URL("../run-affected-unit-tests.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runnerSource, /isFullRunTrigger/u);
});
