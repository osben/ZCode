import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle } from "../src/runtime/methods/title-generation-sidecar.js";

describe("cleanGeneratedTitle", () => {
  it("accepts titles in any script", () => {
    expect(cleanGeneratedTitle('{"title":"Налаштування кешу"}')).toBe("Налаштування кешу");
    expect(cleanGeneratedTitle('{"title":"キャッシュ設計"}')).toBe("キャッシュ設計");
    expect(cleanGeneratedTitle('{"title":"캐시 설계"}')).toBe("캐시 설계");
    expect(cleanGeneratedTitle("Cache design.")).toBe("Cache design");
  });

  // specs/session-title-polish.md 2.2: a lead-in before the JSON must not become the title.
  it("reads title JSON after a lead-in line or on the same line as a lead-in", () => {
    expect(cleanGeneratedTitle('Here is the title:\n```json\n{"title": "Bug fix"}\n```')).toBe(
      "Bug fix",
    );
    expect(cleanGeneratedTitle('```json\n{"title": "Bug fix"}\n```')).toBe("Bug fix");
    expect(cleanGeneratedTitle('Title: {"title":"Bug fix"}')).toBe("Bug fix");
    expect(cleanGeneratedTitle("<think>plan</think>\n```\n{\"title\":\"Кеш\"}\n```")).toBe("Кеш");
    expect(cleanGeneratedTitle("Fix login {redirect} loop")).toBe("Fix login {redirect} loop");
  });

  it("rejects titles without a letter or number", () => {
    expect(cleanGeneratedTitle('{"title":"..."}')).toBeNull();
    expect(cleanGeneratedTitle('{"title":"!!!"}')).toBeNull();
    expect(cleanGeneratedTitle("   ")).toBeNull();
  });
});
