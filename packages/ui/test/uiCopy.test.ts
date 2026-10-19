import { describe, expect, it } from "vitest";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

describe("UI test copy helper", () => {
  it("uses English as the default test locale", () => {
    expect(TEST_LOCALE).toBe("en-US");
  });

  it("resolves English catalog copy and interpolates values", () => {
    const copy = expectedCopy("worktreeSetup.stepCreating", { branch: "feature/test" });

    expect(copy).toContain("feature/test");
    expect(copy).not.toContain("{branch}");
  });

  it("fails clearly when the English catalog key is missing", () => {
    expect(() => expectedCopy("missing.test.key")).toThrow(
      "Missing en-US UI copy for catalog key: missing.test.key",
    );
  });
});
