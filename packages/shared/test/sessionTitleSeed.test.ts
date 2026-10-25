import { describe, expect, it } from "vitest";
import { sanitizeTitleSeed } from "../src/zcode-session-visible-content.js";

const skillTemplate = (name: string, tail: string) =>
  [
    `Use the skill named \`${name}\` for this turn.`,
    `First call the \`Skill\` tool with name \`${name}\` before doing the task.`,
    "After the skill content is loaded, follow its instructions and continue.",
    "",
    tail,
  ].join("\n");

describe("sanitizeTitleSeed", () => {
  it("keeps the skill label of a composer skill mention", () => {
    expect(
      sanitizeTitleSeed("[$brainstorming](/home/u/.skills/brainstorming/SKILL.md) design a cache"),
    ).toBe("$brainstorming design a cache");
  });

  it("extracts the task from the manual /skill prompt", () => {
    expect(sanitizeTitleSeed(skillTemplate("brainstorming", "User request:\ndesign a cache"))).toBe(
      "design a cache",
    );
  });

  it("falls back to the skill name when the manual /skill prompt has no task", () => {
    expect(
      sanitizeTitleSeed(
        skillTemplate(
          "brainstorming",
          "No additional user request was provided. Load the skill and respond according to its instructions.",
        ),
      ),
    ).toBe("$brainstorming");
  });

  it("does not match a drifted template", () => {
    const drifted = skillTemplate("x", "User request:\ndo it").replace("for this turn", "now");
    expect(sanitizeTitleSeed(drifted)).toBe(drifted);
  });

  it("drops the @ of plugin mentions and the # of session mentions", () => {
    expect(sanitizeTitleSeed("[@Linear](plugin://linear@official) list my issues")).toBe(
      "Linear list my issues",
    );
    expect(sanitizeTitleSeed("continue [#Cache work](#sess_abc.1) please")).toBe(
      "continue Cache work please",
    );
  });

  it("uses labels for file and directory links", () => {
    expect(sanitizeTitleSeed("fix [a.ts](./src/a.ts) in [src/](./src/)")).toBe("fix a.ts in src/");
    expect(sanitizeTitleSeed("see [\\[x\\].ts](<./a b/x.ts>)")).toBe("see [x].ts");
  });

  it("leaves ordinary links and pasted code untouched", () => {
    for (const text of [
      "read [the docs](https://example.com/a) first",
      "call handlers[type](payload) here",
      "see [a](b)",
    ]) {
      expect(sanitizeTitleSeed(text)).toBe(text);
    }
  });

  it("handles Windows drive and file: destinations", () => {
    expect(sanitizeTitleSeed("[$s](C:\\Users\\u\\SKILL.md) go")).toBe("$s go");
    expect(sanitizeTitleSeed("fix [a.ts](C:\\repo\\a.ts)")).toBe("fix a.ts");
    expect(sanitizeTitleSeed("fix [a.ts](file:///repo/a.ts)")).toBe("fix a.ts");
  });

  it("keeps a path with balanced parentheses inside one link", () => {
    expect(sanitizeTitleSeed("fix [a.ts](./My Dir (copy)/a.ts) now")).toBe("fix a.ts now");
  });

  it("stays linear on an unclosed link followed by many backslashes", () => {
    const hostile = `see [x](${"\\".repeat(5000)}`;
    const started = performance.now();
    expect(sanitizeTitleSeed(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(500);
    const longPaste = `[$s](/p/SKILL.md) ${"x".repeat(100_000)}`;
    expect(sanitizeTitleSeed(longPaste).startsWith("$s xxx")).toBe(true);
  });

  it("removes bare session ids", () => {
    // Callers collapse whitespace, so the removed token leaves a double space here.
    expect(sanitizeTitleSeed("see #sess_abc123 now")).toBe("see  now");
    expect(sanitizeTitleSeed("see a#sess_abc")).toBe("see a#sess_abc");
  });

  it("returns the original input when nothing readable remains", () => {
    expect(sanitizeTitleSeed("#sess_abc123")).toBe("#sess_abc123");
  });

  it("leaves commands, subagent mentions and plain skill tokens untouched", () => {
    for (const text of [
      "/review src/a.ts",
      "@explorer find X",
      "$brainstorming plan",
      "/goal ship it",
    ]) {
      expect(sanitizeTitleSeed(text)).toBe(text);
    }
  });

  it("is idempotent", () => {
    for (const text of [
      "[$s](/p/SKILL.md) task",
      skillTemplate("s", "User request:\nT"),
      "[@P](plugin://p@m) x #sess_a",
    ]) {
      const once = sanitizeTitleSeed(text);
      expect(sanitizeTitleSeed(once)).toBe(once);
    }
  });
});
