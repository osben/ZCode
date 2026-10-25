import { describe, expect, it } from "vitest";
import { sanitizeTitleSeed } from "@zcode/shared";
import { buildManualSkillPrompt } from "../src/command-center/slash-commands.js";

// The sanitizer mirrors the manual /skill template; this fails when the template drifts.
describe("manual /skill prompt title seed", () => {
  it("extracts the task from the real template", () => {
    expect(sanitizeTitleSeed(buildManualSkillPrompt("brainstorming", "design a cache"))).toBe(
      "design a cache",
    );
  });

  it("falls back to the skill name without a task", () => {
    expect(sanitizeTitleSeed(buildManualSkillPrompt("brainstorming", "  "))).toBe("$brainstorming");
  });
});
