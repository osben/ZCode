// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatErrorBannerDisplayMessage } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import { isChatGptPlanSettingsRecoveryCode } from "@/lib/providerBusinessError.js";
import { usageLimitResetAt } from "@/settings/model-provider-section/chatgptPlanUsage.js";
import {
  buildSessionQuotaBannerState,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}(${Object.values(values).join(",")})` : id,
    },
    locale: "en-US",
  }),
}));

import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";

// specs/chatgpt-plan-signin.md "Limits and recovery in Desktop" (L1–L5).
const intl: IntlInstance = {
  formatMessage({ id }, values = {}) {
    const template = (enUS as Record<string, string>)[id] ?? id;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
    );
  },
};
const NOW = Date.parse("2026-10-15T12:00:00Z");

afterEach(cleanup);

describe("ChatGPT plan error texts", () => {
  it("localizes a sign-in error without the CLI command, live or cold-hydrated (L4, L5)", () => {
    const live = resolveChatErrorBannerDisplayMessage(
      {
        code: "subscription_sharing_invalid_user",
        message:
          "The ChatGPT plan no longer accepts this account. Sign in again with zcode login chatgpt.",
      },
      intl,
    );
    const hydrated = resolveChatErrorBannerDisplayMessage(
      {
        code: "AiSdkModelAdapterError",
        message:
          "The ChatGPT plan no longer accepts this account. Sign in again with zcode login chatgpt.",
        attribution: {
          source: "provider",
          providerErrorCode: "chatpass_v2_scope_not_authorized",
        } as never,
      },
      intl,
    );
    for (const text of [live, hydrated]) {
      expect(text).toContain("Model settings → ChatGPT Plan");
      expect(text).not.toContain("zcode login");
    }
    expect(isChatGptPlanSettingsRecoveryCode("subscription_sharing_invalid_user")).toBe(true);
    expect(isChatGptPlanSettingsRecoveryCode("subscription_sharing_usage_limit_exceeded")).toBe(
      false,
    );
  });
});

describe("ChatGPT plan limit banner", () => {
  it("resets when every exhausted window resets (L2, L3)", () => {
    const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
    expect(
      usageLimitResetAt(
        {
          primary: { usedPercent: 100, resetsAt: at(40) },
          secondary: { usedPercent: 100, resetsAt: at(3000) },
        },
        NOW,
      ),
    ).toBe(NOW + 3000 * 60_000);
    expect(
      usageLimitResetAt(
        { primary: { usedPercent: 100, resetsAt: at(40) }, secondary: { usedPercent: 60 } },
        NOW,
      ),
    ).toBe(NOW + 40 * 60_000);
    expect(usageLimitResetAt({ primary: { usedPercent: 80, resetsAt: at(40) } }, NOW)).toBeNull();
    expect(usageLimitResetAt({ primary: { usedPercent: 100, resetsAt: at(-1) } }, NOW)).toBeNull();
  });

  it("builds a dismissible limit state without an upgrade (L1)", () => {
    const state = buildSessionQuotaBannerState({
      activeProviderId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
      modelId: "gpt-6.1-sol",
      serverChatGptPlanLimited: true,
      chatGptPlanResetAt: NOW + 40 * 60_000,
    });
    expect(state).toMatchObject({
      visible: true,
      kind: "chatgpt-plan-limited",
      providerLimitedResetAt: NOW + 40 * 60_000,
      dismissible: true,
    });
    expect(shouldOfferQuotaBannerUpgrade(state.kind)).toBe(false);
  });

  it("renders the reset time and Manage usage", () => {
    const onManageUsage = vi.fn();
    render(
      createElement(ConversationQuotaBanner, {
        state: buildSessionQuotaBannerState({
          activeProviderId: "account:chatgpt-plan:a1b2c3d4e5f60718",
          snapshot: null,
          modelId: "gpt-6.1-sol",
          serverChatGptPlanLimited: true,
          chatGptPlanResetAt: null,
        }),
        onDismiss: vi.fn(),
        onManageUsage,
      }),
    );
    expect(screen.getByText(/^chat\.quota\.chatgptPlanLimited\b/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByTestId("quota-banner-manage-usage"));
    expect(onManageUsage).toHaveBeenCalledTimes(1);
  });
});
