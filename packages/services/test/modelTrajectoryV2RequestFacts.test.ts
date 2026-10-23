import { describe, expect, it } from "vitest";
import {
  extractCacheBreakpoints,
  extractRequestParams,
  parseCacheWriteTokens,
  parseStreamTiming,
} from "../src/model-trajectory-v2/domain/requestFacts.js";

describe("extractRequestParams", () => {
  it("reads an Anthropic-shaped body", () => {
    expect(
      extractRequestParams({
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 2048 },
        output_config: { effort: "high" },
        tool_choice: { type: "auto" },
        temperature: 0.2,
        stream: true,
      }),
    ).toEqual({
      maxOutputTokens: 1024,
      thinking: { type: "enabled", budgetTokens: 2048 },
      effort: "high",
      toolChoice: "auto",
      temperature: 0.2,
      stream: true,
    });
  });

  it("keeps thinking without a budget and names a forced tool", () => {
    const params = extractRequestParams({
      thinking: { type: "enabled" },
      tool_choice: { type: "tool", name: "Bash" },
    });
    expect(params.thinking).toEqual({ type: "enabled" });
    expect(params.toolChoice).toBe("tool:Bash");
  });

  it("maps an OpenAI-shaped body", () => {
    expect(
      extractRequestParams({
        max_completion_tokens: 512,
        reasoning_effort: "medium",
        tool_choice: { type: "function", function: { name: "search" } },
      }),
    ).toEqual({
      maxOutputTokens: 512,
      effort: "medium",
      toolChoice: "tool:search",
    });
  });

  it("returns empty params for an empty or missing body", () => {
    expect(extractRequestParams(undefined)).toEqual({});
    expect(extractRequestParams({})).toEqual({});
  });
});

describe("extractCacheBreakpoints", () => {
  it("collects system, tool and message-part markers from the wire body with ttl kept", () => {
    const body = {
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "5m" } },
      ],
      tools: [
        { name: "Bash" },
        { name: "Read", cache_control: { type: "ephemeral" } },
        { name: "Grep", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        { role: "user", content: "plain string" },
        { role: "user", content: [{ type: "text", text: "x" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second", cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
      ],
    };
    expect(extractCacheBreakpoints(body, undefined)).toEqual({
      breakpoints: [
        { location: "system", index: 1, ttl: "5m" },
        { location: "tools", index: 1 },
        { location: "tools", index: 2, ttl: "1h" },
        { location: "message", index: 2, ttl: "5m" },
      ],
      complete: true,
    });
  });

  it("falls back to sdkMessages provider options when wire messages were trimmed", () => {
    const sdkMessages = [
      {
        role: "user",
        content: "x",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
      },
      { role: "assistant", content: "y" },
      {
        role: "user",
        content: "z",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ];
    expect(extractCacheBreakpoints({ system: [] }, sdkMessages)).toEqual({
      breakpoints: [
        { location: "message", index: 0, ttl: "1h" },
        { location: "message", index: 2 },
      ],
      complete: true,
    });
  });

  it("reports incomplete when neither wire messages nor sdk messages are readable", () => {
    expect(extractCacheBreakpoints(undefined, undefined)).toEqual({
      breakpoints: [],
      complete: false,
    });
    // A wire messages array is authoritative: present (even empty) means complete.
    expect(extractCacheBreakpoints({ messages: [] }, [{ role: "user", content: "x" }])).toEqual({
      breakpoints: [],
      complete: true,
    });
  });
});

describe("parseStreamTiming", () => {
  it("keeps valid non-negative fields", () => {
    expect(
      parseStreamTiming({
        stream: true,
        timeToFirstProviderEventMs: 120,
        timeToFirstContentMs: 300,
        timeToFirstTextMs: 480,
      }),
    ).toEqual({
      stream: true,
      timeToFirstProviderEventMs: 120,
      timeToFirstContentMs: 300,
      timeToFirstTextMs: 480,
    });
  });

  it("returns undefined without a boolean stream flag", () => {
    expect(parseStreamTiming(undefined)).toBeUndefined();
    expect(parseStreamTiming(null)).toBeUndefined();
    expect(parseStreamTiming("streaming")).toBeUndefined();
    expect(parseStreamTiming({ timeToFirstContentMs: 5 })).toBeUndefined();
    expect(parseStreamTiming({ stream: "yes", timeToFirstContentMs: 5 })).toBeUndefined();
  });

  it("drops negative and non-finite values", () => {
    expect(
      parseStreamTiming({ stream: false, timeToFirstContentMs: 250, timeToFirstTextMs: -1 }),
    ).toEqual({ stream: false, timeToFirstContentMs: 250 });
    expect(parseStreamTiming({ stream: true, timeToFirstTextMs: Number.NaN })).toEqual({
      stream: true,
    });
  });
});

describe("parseCacheWriteTokens", () => {
  it("reads a finite number", () => {
    expect(parseCacheWriteTokens({ cacheWriteTokens: 128 })).toBe(128);
  });

  it("returns undefined for missing or non-numeric values", () => {
    expect(parseCacheWriteTokens(undefined)).toBeUndefined();
    expect(parseCacheWriteTokens({})).toBeUndefined();
    expect(parseCacheWriteTokens({ cacheWriteTokens: "64" })).toBeUndefined();
  });
});
