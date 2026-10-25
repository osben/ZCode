import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8").replace(
  /\s+/gu,
  " ",
);

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
      expect(rule).toContain(`[role="${role}"]:not([aria-disabled="true"]):not([data-disabled])`);
    }
    expect(rule).toMatch(
      /\[role="button"\]:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\s*\[data-disabled\]\s*\)/u,
    );
  });
});
