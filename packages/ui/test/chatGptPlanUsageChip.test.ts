// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openExternal: vi.fn() }) }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id.split(".").pop()}(${Object.values(values).join(",")})` : id.split(".").pop(),
    },
    locale: "en-US",
  }),
}));

import { ChatGptPlanUsageChip } from "@/chat-input-toolbar/ChatGptPlanUsageChip.js";

// specs/chatgpt-plan-signin.md "Usage across the app" (S1, S7).
const NOW = Date.parse("2026-10-15T12:00:00Z");

afterEach(cleanup);

describe("ChatGptPlanUsageChip", () => {
  it("shows the plan and the tightest window in its severity (S1)", () => {
    render(
      createElement(ChatGptPlanUsageChip, {
        nowMs: NOW,
        usage: {
          planType: "plus",
          primary: { usedPercent: 42, resetsAt: new Date(NOW + 3600_000).toISOString() },
          secondary: { usedPercent: 76, resetsAt: new Date(NOW + 3 * 86400_000).toISOString() },
        },
      }),
    );
    const chip = screen.getByTestId("chatgpt-plan-usage-chip");
    expect(chip.textContent).toBe("Plus · left(24)");
    expect(chip.getAttribute("data-severity")).toBe("warning");
    expect(chip.getAttribute("aria-label")).toBe("Plus · left(24), warning");
  });

  it("falls back to ChatGPT and shows a reached limit as critical (S7)", () => {
    render(
      createElement(ChatGptPlanUsageChip, {
        nowMs: NOW,
        usage: { limitReached: true, primary: { usedPercent: 100 } },
      }),
    );
    const chip = screen.getByTestId("chatgpt-plan-usage-chip");
    expect(chip.textContent).toBe("planFallback · limitReached");
    expect(chip.getAttribute("data-severity")).toBe("critical");
  });
});
