import { describe, expect, it } from "vitest";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import {
  chatGptPlanAccountKeyOfGroup,
  withChatGptPlanUsageHints,
} from "@/lib/chatGptPlanUsageHints.js";

// specs/chatgpt-plan-signin.md "Usage across the app" (S5, S7).
const K = "a1b2c3d4e5f60718";
const NOW = Date.parse("2026-10-15T12:00:00Z");
const format = ({ id, values }: { id: string; values?: Record<string, string | number> }) =>
  values
    ? `${id.split(".").pop()}(${Object.values(values).join(",")})`
    : (id.split(".").pop() ?? id);
const group = (providerId: string): ModelSelectGroup => ({
  key: `registry-provider:${providerId}`,
  label: providerId,
  labelBadge: "Subscription",
  items: [],
});

describe("withChatGptPlanUsageHints", () => {
  it("recognises only per-account ChatGPT plan groups", () => {
    expect(chatGptPlanAccountKeyOfGroup(group(`account:chatgpt-plan:${K}`))).toBe(K);
    expect(chatGptPlanAccountKeyOfGroup(group("account:chatgpt-plan"))).toBeNull();
    expect(chatGptPlanAccountKeyOfGroup(group("openai"))).toBeNull();
  });

  it("adds the tightest window with its countdown and keeps other groups unchanged (S5)", () => {
    const other = group("openai");
    const [hinted, untouched] = withChatGptPlanUsageHints(
      [group(`account:chatgpt-plan:${K}`), other],
      new Map([
        [
          K,
          {
            primary: { usedPercent: 42, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
            secondary: { usedPercent: 76, windowMinutes: 10080 },
          },
        ],
      ]),
      NOW,
      format,
    );
    expect(hinted?.labelHint).toEqual({
      text: "left(24)",
      tone: "warning",
      title: "fiveHour: left(58) · weekly: left(24)",
    });
    expect(untouched).toBe(other);
  });

  it("shows the countdown when the tightest window reports its reset", () => {
    const [hinted] = withChatGptPlanUsageHints(
      [group(`account:chatgpt-plan:${K}`)],
      new Map([
        [K, { primary: { usedPercent: 95, resetsAt: new Date(NOW + 90 * 60_000).toISOString() } }],
      ]),
      NOW,
      format,
    );
    expect(hinted?.labelHint).toEqual({
      text: "left(5)",
      tone: "critical",
      title: "resetsIn(hm(1,30)) · fiveHour: left(5)",
    });
  });

  it("marks a reached limit in critical tone (S7)", () => {
    const [hinted] = withChatGptPlanUsageHints(
      [group(`account:chatgpt-plan:${K}`)],
      new Map([[K, { limitReached: true, primary: { usedPercent: 100 } }]]),
      NOW,
      format,
    );
    expect(hinted?.labelHint).toMatchObject({ text: "limitReached", tone: "critical" });
  });
});
