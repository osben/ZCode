import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles.css", "utf8").replace(/\s+/gu, " ");

describe("cursor pointer base rule", () => {
  const rule = styles.match(/@layer base \{[^}]*cursor: pointer;[^}]*\}/u)?.[0] ?? "";

  it("exists in the base layer", () => {
    expect(rule).toContain("cursor: pointer;");
  });

  it("covers element-level clickables with disabled states excluded", () => {
    expect(rule).toContain('a[href]:not([aria-disabled="true"])');
    expect(rule).toContain('button:not(:disabled):not([aria-disabled="true"])');
    expect(rule).toContain('summary:not([aria-disabled="true"])');
  });

  it("covers Radix div-based interactive roles (they use data-disabled, not :disabled)", () => {
    for (const role of ["menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]) {
      const dataDisabledExclusion =
        role === "option"
          ? ':not([data-disabled="true"]):not([data-disabled=""])'
          : ":not([data-disabled])";
      expect(rule).toContain(
        `[role="${role}"]:not([aria-disabled="true"])${dataDisabledExclusion}`,
      );
    }
    expect(rule).toMatch(
      /\[role="button"\]:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\s*\[data-disabled\]\s*\)/u,
    );
  });
});
