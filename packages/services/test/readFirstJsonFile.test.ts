import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFirstJsonFile } from "../src/session/readFirstJsonFile.js";

describe("readFirstJsonFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "read-first-json-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the first candidate when it exists", async () => {
    const live = join(dir, "task.json");
    await writeFile(live, JSON.stringify({ from: "live" }));

    await expect(readFirstJsonFile([live, join(dir, "task.deleted.json")])).resolves.toEqual({
      from: "live",
    });
  });

  it("prefers the first candidate when both exist", async () => {
    const live = join(dir, "task.json");
    const deleted = join(dir, "task.deleted.json");
    await writeFile(live, JSON.stringify({ from: "live" }));
    await writeFile(deleted, JSON.stringify({ from: "deleted" }));

    await expect(readFirstJsonFile([live, deleted])).resolves.toEqual({ from: "live" });
  });

  it("falls through to the next candidate when the first is missing", async () => {
    const deleted = join(dir, "task.deleted.json");
    await writeFile(deleted, JSON.stringify({ from: "deleted" }));

    await expect(readFirstJsonFile([join(dir, "task.json"), deleted])).resolves.toEqual({
      from: "deleted",
    });
  });

  it("returns null when no candidate exists", async () => {
    await expect(
      readFirstJsonFile([join(dir, "task.json"), join(dir, "task.deleted.json")]),
    ).resolves.toBeNull();
  });

  it("treats a missing parent directory as a missing file", async () => {
    await expect(readFirstJsonFile([join(dir, "missing", "task.json")])).resolves.toBeNull();
  });

  it("treats a path below a regular file as a missing file", async () => {
    const file = join(dir, "plain");
    await writeFile(file, "x");

    await expect(readFirstJsonFile([join(file, "task.json")])).resolves.toBeNull();
  });

  it("rejects on invalid JSON without trying later candidates", async () => {
    const live = join(dir, "task.json");
    const deleted = join(dir, "task.deleted.json");
    await mkdir(dir, { recursive: true });
    await writeFile(live, "{ not json");
    await writeFile(deleted, JSON.stringify({ from: "deleted" }));

    await expect(readFirstJsonFile([live, deleted])).rejects.toThrow(SyntaxError);
  });
});
