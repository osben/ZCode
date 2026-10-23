import {
  formatBytes,
  formatMs,
  formatRatio,
  formatTokens,
  payloadPreview,
} from "@/model-trajectory-v2/domain/format.js";
import { describe, expect, it } from "vitest";

describe("payloadPreview", () => {
  it("flattens string payloads to one line", () => {
    expect(payloadPreview("  hello \n  world  ")).toBe("hello world");
    expect(payloadPreview("line1\nline2\ttabbed")).toBe("line1 line2 tabbed");
  });

  it("renders plain objects as one-line JSON", () => {
    expect(payloadPreview({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
  });

  it("unwraps error-text and content payloads", () => {
    expect(payloadPreview({ type: "error-text", value: "boom happened" })).toBe("boom happened");
    expect(payloadPreview({ type: "note", content: "file text" })).toBe("file text");
  });

  it("returns an empty string for nullish values", () => {
    expect(payloadPreview(undefined)).toBe("");
    expect(payloadPreview(null)).toBe("");
  });

  it("truncates to the limit with an ellipsis", () => {
    const preview = payloadPreview("x".repeat(300), 10);
    expect(preview).toBe("xxxxxxxxx…");
    expect(preview).toHaveLength(10);
    // Truncation happens after flattening, so it counts visible characters.
    expect(payloadPreview(`{"key":"${"v".repeat(20)}"}`, 12)).toBe('{"key":"vvv…');
  });
});

describe("formatBytes", () => {
  it("renders unknown as a dash", () => {
    expect(formatBytes(undefined)).toBe("—");
  });

  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024)).toBe("5.0 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("formatMs", () => {
  it("renders unknown and non-finite as a dash", () => {
    expect(formatMs(undefined)).toBe("—");
    expect(formatMs(Number.NaN)).toBe("—");
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats milliseconds, seconds and minutes", () => {
    expect(formatMs(499.6)).toBe("500 ms");
    expect(formatMs(1500)).toBe("1.50s");
    expect(formatMs(9500)).toBe("9.50s");
    expect(formatMs(12500)).toBe("12.5s");
    expect(formatMs(60_000)).toBe("1m 0s");
    expect(formatMs(90_000)).toBe("1m 30s");
  });

  it("carries rounding into the next unit instead of showing 60s", () => {
    expect(formatMs(999.6)).toBe("1.00s");
    expect(formatMs(9_996)).toBe("10.0s");
    expect(formatMs(59_960)).toBe("1m 0s");
    expect(formatMs(119_500)).toBe("2m 0s");
    expect(formatMs(125_400)).toBe("2m 5s");
  });
});

describe("formatRatio", () => {
  it("renders unknown and non-finite as a dash", () => {
    expect(formatRatio(undefined)).toBe("—");
    expect(formatRatio(Number.NaN)).toBe("—");
  });

  it("formats ratios as rounded percentages", () => {
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(0.423)).toBe("42%");
    expect(formatRatio(0.5)).toBe("50%");
    expect(formatRatio(1)).toBe("100%");
  });
});

describe("formatTokens", () => {
  it("renders unknown as a dash and formats numbers in en-US groups", () => {
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});
