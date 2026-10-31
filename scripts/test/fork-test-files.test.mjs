import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const readManifest = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

// Contract: specs/fork-test-pipeline.md.
test("fork test manifest is sorted, unique, present on disk and disjoint from engineering", async () => {
  const fork = await readManifest("scripts/fork-test-files.json");
  const engineering = new Set(await readManifest("scripts/engineering-test-files.json"));
  assert.ok(Array.isArray(fork) && fork.length > 0);
  assert.deepEqual(fork, [...new Set(fork)].sort(), "manifest must be sorted and duplicate-free");
  const missing = [];
  for (const file of fork) {
    try {
      await access(join(root, file));
    } catch {
      missing.push(file);
    }
  }
  assert.deepEqual(missing, [], "manifest lists files that do not exist");
  assert.deepEqual(
    fork.filter((file) => engineering.has(file)),
    [],
    "fork tests must not duplicate engineering manifest entries",
  );
});
