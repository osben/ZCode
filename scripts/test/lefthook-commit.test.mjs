import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./lefthook-fixture.mjs";

test("fresh and legacy installs run real commit hooks and are repeatable", async (t) => {
  for (const legacy of [false, true]) {
    const f = await fixture(t, { legacy });
    await f.install();
    await f.install();
    await f.put("workflow.yml", "on:   push\nname:   'ci'\n");
    await f.git("add", "workflow.yml");
    const result = await f.commit();
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(await f.git("show", "HEAD:workflow.yml"), 'on: push\nname: "ci"');
    assert.equal(await f.git("status", "--porcelain", "workflow.yml"), "");
    if (legacy) assert.equal(await f.git("config", "core.hooksPath"), ".husky/_");
  }
});

test("partial staging formats the index and preserves unstaged and untracked work", async (t) => {
  const f = await fixture(t);
  await f.install();
  const padding = Array.from({ length: 20 }, (_, i) => `  "padding${i}": ${i},`).join("\n");
  const staged = `{\n  "staged":1,\n${padding}\n  "unstaged": 0\n}\n`;
  await f.put("tracked.json", staged);
  await f.git("add", "tracked.json");
  await f.put("tracked.json", staged.replace('"unstaged": 0', '"unstaged": 2'));
  await f.put("untracked.txt", "keep me\n");
  const result = await f.commit();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const committed = JSON.parse(await f.git("show", "HEAD:tracked.json"));
  assert.equal(committed.staged, 1);
  assert.equal(committed.unstaged, 0);
  assert.match(await readFile(join(f.root, "tracked.json"), "utf8"), /"unstaged"\s*:\s*2/u);
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "keep me\n");
  assert.match(await f.git("diff", "--", "tracked.json"), /unstaged/u);
});

test("special filenames are formatted without shell interpretation", async (t) => {
  const f = await fixture(t);
  await f.install();
  const names = ["space name.json", "it's.json", "%PATH%.json", "дані.json", "-leading.json"];
  for (const name of names) {
    await f.put(name, '{"value":1}\n');
    await f.git("add", "--", name);
  }
  const result = await f.commit();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  for (const name of names) assert.equal(await f.git("show", `HEAD:${name}`), '{ "value": 1 }');
});

test("overlapping formatter and unstaged edits block commit and restore original work", async (t) => {
  const f = await fixture(t);
  await f.install();
  const head = await f.git("rev-parse", "HEAD");
  const staged = '{"staged":1}\n';
  const working = '{"staged":1,"unstaged":2}\n';
  await f.put("tracked.json", staged);
  await f.git("add", "tracked.json");
  await f.put("tracked.json", working);
  const result = await f.commit();
  assert.notEqual(result.code, 0);
  assert.equal(await f.git("rev-parse", "HEAD"), head);
  assert.equal(await f.git("show", ":tracked.json"), staged.trim());
  assert.equal(await readFile(join(f.root, "tracked.json"), "utf8"), working);
});

test("lint errors block commit and preserve unrelated files", async (t) => {
  const f = await fixture(t);
  await f.install();
  const before = await f.git("rev-parse", "HEAD");
  await f.put(
    "too-many-lines.ts",
    // The max-lines limit is 800 (upstream .oxlintrc.json); 801 short lines exceed it but stay under the 20000-byte staged-size limit.
    Array.from({ length: 801 }, (_, i) => `export const v${i}=${i};`).join("\n"),
  );
  await f.git("add", "too-many-lines.ts");
  await f.put("untracked.txt", "keep me\n");
  const result = await f.commit();
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /max-lines/u);
  assert.equal(await f.git("rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "keep me\n");
});

test("both pre-format and post-format staged-size limits block real commits", async (t) => {
  const f = await fixture(t);
  await f.install();
  await f.put("oversize.txt", "x".repeat(20_001));
  await f.git("add", "oversize.txt");
  let result = await f.commit();
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /20001/u);
  await f.git("rm", "--cached", "oversize.txt");
  const compact = JSON.stringify(
    Object.fromEntries(Array.from({ length: 1400 }, (_, i) => [`k${i}`, i])),
  );
  assert.ok(Buffer.byteLength(compact) < 20_000);
  await f.put("expands.json", compact);
  await f.git("add", "expands.json");
  result = await f.commit();
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /20000 bytes/u);
  assert.match(result.stdout + result.stderr, /staged-size-after/u);
});
