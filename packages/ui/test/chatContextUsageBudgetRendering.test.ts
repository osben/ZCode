import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const quotaTone = vi.hoisted<{ value: "available" | "urgent" | null }>(() => ({ value: null }));

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ContextContentBody: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  ContextContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ContextTrigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement("button", props, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/chat-input-toolbar/contextQuotaResetOpportunityReminder.js")
    >();
  return {
    ...actual,
    resolveContextQuotaResetOpportunityTriggerTone: () => quotaTone.value,
  };
});

import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";

function renderContextUsage(
  taskUsage: {
    used: number;
    size: number;
    autoCompactThresholdTokens: number | null;
    microcompactThresholdTokens: number | null;
  },
  locale: "en-US" | "uk-UA" | "zh-CN" = "en-US",
): string {
  function ContextUsageHarness() {
    const { intl, locale } = useZCodeIntl();
    return createElement(ChatContextUsage, {
      intl,
      locale,
      selectedProvider: "openai",
      taskUsage,
    });
  }

  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale }, createElement(ContextUsageHarness)),
  );
}

describe("ChatContextUsage runtime compaction budget rendering", () => {
  it("renders warning and the authoritative auto-compact threshold at microcompact", () => {
    const markup = renderContextUsage({
      used: 149_400,
      size: 200_000,
      autoCompactThresholdTokens: 166_000,
      microcompactThresholdTokens: 149_400,
    });

    expect(markup).toContain('data-usage-tone="warning"');
    expect(markup).toContain("text-warning");
    expect(markup).toContain("≈166K (83%)");
    expect(markup).toContain("Warning: microcompact threshold reached.");
  });

  it("renders critical at auto-compact and stays normal when auto-compact is disabled", () => {
    const criticalMarkup = renderContextUsage({
      used: 166_000,
      size: 200_000,
      autoCompactThresholdTokens: 166_000,
      microcompactThresholdTokens: 149_400,
    });
    expect(criticalMarkup).toContain('data-usage-tone="critical"');
    expect(criticalMarkup).toContain("text-destructive");
    expect(criticalMarkup).toContain("≈166K (83%)");
    expect(criticalMarkup).toContain("Critical: auto-compact threshold reached.");

    const disabledMarkup = renderContextUsage({
      used: 180_000,
      size: 200_000,
      autoCompactThresholdTokens: null,
      microcompactThresholdTokens: null,
    });
    expect(disabledMarkup).toContain('data-usage-tone="normal"');
    expect(disabledMarkup).not.toContain("text-warning");
    expect(disabledMarkup).not.toContain("text-destructive");
    expect(disabledMarkup).not.toContain("≈166K");
  });

  it("localizes the accessible budget status", () => {
    expect(
      renderContextUsage(
        {
          used: 149_400,
          size: 200_000,
          autoCompactThresholdTokens: 166_000,
          microcompactThresholdTokens: 149_400,
        },
        "uk-UA",
      ),
    ).toContain("Попередження: досягнуто порогу мікрокомпактування.");
    expect(
      renderContextUsage(
        {
          used: 166_000,
          size: 200_000,
          autoCompactThresholdTokens: 166_000,
          microcompactThresholdTokens: 149_400,
        },
        "zh-CN",
      ),
    ).toContain("严重：已达到自动压缩阈值。");
  });

  it("keeps a quota opportunity tone ahead of the steady context tone", () => {
    quotaTone.value = "available";
    const markup = renderContextUsage({
      used: 149_400,
      size: 200_000,
      autoCompactThresholdTokens: 166_000,
      microcompactThresholdTokens: 149_400,
    });
    quotaTone.value = null;

    const trigger = markup.match(/<button\b[^>]*>/)?.[0] ?? "";
    expect(trigger).toContain('data-usage-tone="warning"');
    expect(trigger).toContain("text-success");
    expect(trigger).not.toContain("text-warning");
    expect(trigger).toContain("Warning: microcompact threshold reached.");
  });
});
