// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatErrorBannerDisplayMessage } from "@/ChatErrorBanner.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import { isChatGptPlanSettingsRecoveryCode } from "@/lib/providerBusinessError.js";
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
  it("builds a dismissible limit state without an upgrade (L1)", () => {
    const state = buildSessionQuotaBannerState({
      activeProviderId: "account:chatgpt-plan:a1b2c3d4e5f60718",
      snapshot: null,
      modelId: "gpt-6.1-sol",
      serverChatGptPlanLimited: true,
    });
    expect(state).toMatchObject({
      visible: true,
      kind: "chatgpt-plan-limited",
      providerLimitedResetAt: null,
      dismissible: true,
    });
    expect(shouldOfferQuotaBannerUpgrade(state.kind)).toBe(false);
  });

  it("renders Manage usage without a reset time or auto-continue (L2)", () => {
    const onManageUsage = vi.fn();
    render(
      createElement(ConversationQuotaBanner, {
        state: buildSessionQuotaBannerState({
          activeProviderId: "account:chatgpt-plan:a1b2c3d4e5f60718",
          snapshot: null,
          modelId: "gpt-6.1-sol",
          serverChatGptPlanLimited: true,
        }),
        onDismiss: vi.fn(),
        onManageUsage,
      }),
    );
    expect(screen.getByText(/^chat\.quota\.chatgptPlanLimited\b/)).toBeTruthy();
    expect(screen.queryByText(/resetAt/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByTestId("quota-banner-manage-usage"));
    expect(onManageUsage).toHaveBeenCalledTimes(1);
  });
});
