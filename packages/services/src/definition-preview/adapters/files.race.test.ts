import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node has no openat(), so a directory swapped for a symlink between the walk and open() cannot
// be prevented by descriptor; these tests simulate that swap and assert the post-open check
// rejects the read.
const fsMocks = vi.hoisted(() => ({
  realpathOverride: undefined as ((path: string) => string | undefined) | undefined,
  lstatOverride: undefined as ((path: string) => object | undefined) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => fsMocks.realpathOverride?.(path) ?? actual.realpath(path),
    lstat: async (path: string, options?: { bigint?: boolean }) =>
      fsMocks.lstatOverride?.(path) ?? actual.lstat(path, options as never),
  };
});

const { createDefinitionFilesAdapter } = await import("./files.js");

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "definition-preview-race-"));
  root = join(base, "skill");
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "references", "schemas.md"), "# Schemas\n");
});

afterEach(async () => {
  fsMocks.realpathOverride = undefined;
  fsMocks.lstatOverride = undefined;
  await rm(base, { recursive: true, force: true });
});

describe("readFile post-open verification", () => {
  it("rejects when the opened file now resolves outside the root", async () => {
    fsMocks.realpathOverride = (path) =>
      path.endsWith(join("references", "schemas.md"))
        ? join(base, "outside", "secret.md")
        : undefined;
    const result = await createDefinitionFilesAdapter().readFile(root, [
      "references",
      "schemas.md",
    ]);
    expect(result).toEqual({ status: "rejected" });
  });

  it("rejects when the file at the canonical path is not the opened inode", async () => {
    let checks = 0;
    fsMocks.lstatOverride = (path) => {
      if (!path.endsWith("schemas.md")) return undefined;
      checks += 1;
      // The walk's lstat sees the real file; the post-open lstat sees a different inode.
      return checks === 1
        ? undefined
        : { dev: 1n, ino: 999_999_999_999_999_999n, isFile: () => true };
    };
    const result = await createDefinitionFilesAdapter().readFile(root, [
      "references",
      "schemas.md",
    ]);
    expect(result).toEqual({ status: "rejected" });
    expect(checks).toBe(2);
  });
});
