import { describe, expect, it } from "vitest";
import {
  isStrictlyInsideWorkspace,
  nestedInstructionKey,
  resolveNestedInstructionTargets,
} from "../src/context/nested-instructions/touched-paths.js";

const CWD = "/repo";

function targets(toolName: string, toolInput: unknown, workingDirectory = CWD, toolOutput?: unknown) {
  return resolveNestedInstructionTargets({
    toolName,
    toolInput,
    toolOutput,
    workingDirectory,
    platform: "linux",
  });
}

describe("resolveNestedInstructionTargets", () => {
  it.each(["Read", "Edit", "Write"])("maps %s file_path to a file location", (toolName) => {
    expect(targets(toolName, { file_path: "/repo/packages/foo/src/a.ts" })).toEqual({
      locations: [{ path: "/repo/packages/foo/src/a.ts", kind: "file" }],
      touchedFiles: ["/repo/packages/foo/src/a.ts"],
    });
  });

  it("resolves a relative file_path against the live working directory", () => {
    expect(targets("Read", { file_path: "packages/foo/a.ts" }, "/repo").locations).toEqual([
      { path: "/repo/packages/foo/a.ts", kind: "file" },
    ]);
  });

  it("returns nothing for a file tool without a file_path", () => {
    expect(targets("Read", {})).toEqual({ locations: [], touchedFiles: [] });
  });

  it("maps every file an ApplyPatch reported, including move targets", () => {
    const output = {
      files: [
        { filePath: "/repo/packages/foo/a.ts", type: "update", movePath: "/repo/packages/bar/b.ts" },
        { filePath: "packages/baz/c.ts", type: "add" },
      ],
    };
    const result = targets("ApplyPatch", { patch_text: "ignored" }, CWD, output);
    expect(result.touchedFiles).toEqual([
      "/repo/packages/foo/a.ts",
      "/repo/packages/bar/b.ts",
      "/repo/packages/baz/c.ts",
    ]);
    expect(result.locations.every((location) => location.kind === "file")).toBe(true);
  });

  it("returns nothing for an ApplyPatch without a reported file list", () => {
    expect(targets("ApplyPatch", { patch_text: "not a patch" })).toEqual({
      locations: [],
      touchedFiles: [],
    });
  });

  it("uses an explicit Glob/Grep path with unknown kind so discovery can stat it", () => {
    expect(targets("Grep", { pattern: "x", path: "packages/foo" }).locations).toEqual([
      { path: "/repo/packages/foo", kind: "unknown" },
    ]);
  });

  it("uses the working directory when Glob/Grep has no path", () => {
    expect(targets("Glob", { pattern: "**/*.ts" }, "/repo/packages/foo").locations).toEqual([
      { path: "/repo/packages/foo", kind: "directory" },
    ]);
  });

  it("uses the live cwd for Bash, which has no cwd input", () => {
    expect(targets("Bash", { command: "cd packages/foo && pnpm test" }, "/repo/packages/foo")).toEqual({
      locations: [{ path: "/repo/packages/foo", kind: "directory" }],
      touchedFiles: [],
    });
  });

  it("ignores tools that do not touch the workspace through paths", () => {
    expect(targets("WebFetch", { url: "https://example.com" })).toEqual({
      locations: [],
      touchedFiles: [],
    });
  });
});

describe("isStrictlyInsideWorkspace", () => {
  it("accepts descendants and rejects the root itself", () => {
    expect(isStrictlyInsideWorkspace("/repo/packages/foo", "/repo", "linux")).toBe(true);
    expect(isStrictlyInsideWorkspace("/repo", "/repo", "linux")).toBe(false);
  });

  it("rejects sibling paths that only share a name prefix", () => {
    expect(isStrictlyInsideWorkspace("/repo2/packages", "/repo", "linux")).toBe(false);
  });

  it("rejects paths above the root and outside it", () => {
    expect(isStrictlyInsideWorkspace("/", "/repo", "linux")).toBe(false);
    expect(isStrictlyInsideWorkspace("/elsewhere/x", "/repo", "linux")).toBe(false);
    expect(isStrictlyInsideWorkspace("/repo/../etc", "/repo", "linux")).toBe(false);
  });

  it("handles Windows drive paths and drive-letter case", () => {
    expect(isStrictlyInsideWorkspace("C:\\repo\\packages\\foo", "c:\\repo", "win32")).toBe(true);
    expect(isStrictlyInsideWorkspace("D:\\other", "C:\\repo", "win32")).toBe(false);
  });
});

describe("nestedInstructionKey", () => {
  it("keeps case on linux", () => {
    expect(nestedInstructionKey("/repo/Packages/a/AGENTS.md", "linux")).not.toBe(
      nestedInstructionKey("/repo/packages/a/AGENTS.md", "linux"),
    );
  });

  it("case-folds on darwin, where the default volume is case-insensitive", () => {
    expect(nestedInstructionKey("/Repo/Packages/a/AGENTS.md", "darwin")).toBe(
      nestedInstructionKey("/repo/packages/a/agents.md", "darwin"),
    );
  });

  it("treats Windows drive case and Git-Bash drive aliases as one key", () => {
    expect(nestedInstructionKey("C:\\Repo\\Packages\\AGENTS.md", "win32")).toBe(
      nestedInstructionKey("c:\\repo\\packages\\agents.md", "win32"),
    );
    expect(nestedInstructionKey("/c/repo/packages/AGENTS.md", "win32")).toBe(
      nestedInstructionKey("C:\\repo\\packages\\agents.md", "win32"),
    );
  });
});
