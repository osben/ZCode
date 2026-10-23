import { describe, expect, it } from "vitest";
import { parseDefinitionRelativePath } from "./relativePath.js";

describe("parseDefinitionRelativePath", () => {
  it("splits plain relative paths on both separators", () => {
    expect(parseDefinitionRelativePath("SKILL.md")).toEqual(["SKILL.md"]);
    expect(parseDefinitionRelativePath("references/schemas.md")).toEqual([
      "references",
      "schemas.md",
    ]);
    expect(parseDefinitionRelativePath("scripts\\init.py")).toEqual(["scripts", "init.py"]);
  });

  it.each([
    ["empty", ""],
    ["parent segment", "../outside.md"],
    ["nested parent segment", "references/../../outside.md"],
    ["current segment", "./SKILL.md"],
    ["empty segment", "references//x.md"],
    ["trailing separator", "references/"],
    ["absolute POSIX", "/etc/passwd"],
    ["UNC", "\\\\server\\share\\x"],
    ["drive letter", "C:\\Windows\\win.ini"],
    ["drive-relative", "C:x"],
    ["alternate data stream", "SKILL.md:hidden"],
    ["NUL byte", "SKILL.md\0.txt"],
  ])("rejects %s", (_label, raw) => {
    expect(parseDefinitionRelativePath(raw)).toBeNull();
  });
});
