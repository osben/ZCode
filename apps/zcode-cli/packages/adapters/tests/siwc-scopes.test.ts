import { describe, expect, it } from "vitest";
import { isSiwcPlanUsageEntitled, parseSiwcScopes } from "../src/auth/siwc/siwc-scopes.js";

describe("SIWC scope parsing", () => {
  it("parses space-delimited scopes and ignores extra whitespace", () => {
    expect(parseSiwcScopes("openid  profile\temail\toffline_access resource.invoke")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
    ]);
  });

  it("returns an empty list for missing or blank scope strings", () => {
    expect(parseSiwcScopes(undefined)).toEqual([]);
    expect(parseSiwcScopes(null)).toEqual([]);
    expect(parseSiwcScopes("   ")).toEqual([]);
  });

  it("gates plan entitlement on chatgpt.tokens.use.direct", () => {
    expect(isSiwcPlanUsageEntitled(["openid", "profile", "chatgpt.tokens.use.direct"])).toBe(true);
    expect(isSiwcPlanUsageEntitled(["openid", "profile"])).toBe(false);
    expect(isSiwcPlanUsageEntitled([])).toBe(false);
  });
});
