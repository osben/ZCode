import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle } from "../src/runtime/methods/title-generation-sidecar.js";

describe("cleanGeneratedTitle", () => {
  it("accepts titles in any script", () => {
    expect(cleanGeneratedTitle('{"title":"Налаштування кешу"}')).toBe("Налаштування кешу");
    expect(cleanGeneratedTitle('{"title":"キャッシュ設計"}')).toBe("キャッシュ設計");
    expect(cleanGeneratedTitle('{"title":"캐시 설계"}')).toBe("캐시 설계");
    expect(cleanGeneratedTitle("Cache design.")).toBe("Cache design");
  });

  it("rejects titles without a letter or number", () => {
    expect(cleanGeneratedTitle('{"title":"..."}')).toBeNull();
    expect(cleanGeneratedTitle('{"title":"!!!"}')).toBeNull();
    expect(cleanGeneratedTitle("   ")).toBeNull();
  });
});
