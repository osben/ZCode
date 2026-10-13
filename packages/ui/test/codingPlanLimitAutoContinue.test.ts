// @vitest-environment jsdom

import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  codingPlanAutoContinueDelayMs,
  parseCodingPlanLimitResetAt,
} from "@/lib/codingPlanLimitAutoContinue.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { HIDDEN_SESSION_QUOTA_BANNER_STATE } from "@/v4/sessionQuotaBannerState.js";

const resetMessage = "Usage limit reached for 5 hour. Your limit will reset at 2026-10-13 10:16:31";

describe("Coding Plan quota reset parsing", () => {
  it.each([
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  ])("parses a supported provider reset as UTC+08:00 (%s)", (providerId) => {
    expect(parseCodingPlanLimitResetAt(providerId, "1308", resetMessage)).toBe(
      Date.parse("2026-10-13T02:16:31Z"),
    );
  });

  it.each([
    [
      "wrong business code",
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      "1309",
      resetMessage,
    ],
    ["Start Plan", BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "1308", resetMessage],
    ["unsupported provider", "other-provider", "1308", resetMessage],
    [
      "malformed calendar date",
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      "1308",
      "Usage limit reached for 5 hours. Your limit will reset at 2026-02-30 10:16:31",
    ],
    [
      "missing reset timestamp",
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      "1308",
      "Usage limit reached for 5 hours.",
    ],
  ])("rejects %s", (_case, providerId, businessCode, message) => {
    expect(parseCodingPlanLimitResetAt(providerId, businessCode, message)).toBeNull();
  });

  it("accepts the plural five-hour message", () => {
    expect(
      parseCodingPlanLimitResetAt(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        "1308",
        resetMessage.replace("5 hour.", "5 hours."),
      ),
    ).toBe(Date.parse("2026-10-13T02:16:31Z"));
  });
});

describe("Coding Plan auto-continue delay", () => {
  it("waits until reset and adds a grace period within one to three minutes", () => {
    const resetAt = 10_000;
    expect(codingPlanAutoContinueDelayMs(resetAt, 0, 0)).toBe(70_000);
    expect(codingPlanAutoContinueDelayMs(resetAt, 0, 0.5)).toBe(130_000);
    expect(codingPlanAutoContinueDelayMs(resetAt, 0, 1)).toBe(189_999);
  });

  it("starts the grace period from now when reset has passed", () => {
    expect(codingPlanAutoContinueDelayMs(10_000, 20_000, 0)).toBe(60_000);
  });
});

function quotaBannerElement({
  autoContinueDefault = true,
  autoContinueReady = true,
  resetAt = Date.parse("2026-10-13T02:16:31Z"),
  onAutoContinue = vi.fn(),
}: {
  autoContinueDefault?: boolean;
  autoContinueReady?: boolean;
  resetAt?: number;
  onAutoContinue?: () => void;
} = {}) {
  const state = {
    ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
    visible: true,
    kind: "provider-limited" as const,
    providerLimitedBusinessCode: "1308" as const,
    providerLimitedMessage: resetMessage,
    providerLimitedResetAt: resetAt,
    dismissible: true,
  };
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(ConversationQuotaBanner, {
      state,
      onDismiss: vi.fn(),
      autoContinueDefault,
      autoContinueReady,
      onAutoContinue,
    }),
  );
}

function renderQuotaBanner(props: Parameters<typeof quotaBannerElement>[0] = {}) {
  return render(quotaBannerElement(props));
}

describe("ConversationQuotaBanner auto-continue timer", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resumes once after reset plus the selected grace period", () => {
    const resetAt = Date.parse("2026-10-13T02:16:31Z");
    vi.useFakeTimers();
    vi.setSystemTime(resetAt - 5_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onAutoContinue = vi.fn();
    renderQuotaBanner({ onAutoContinue });

    act(() => vi.advanceTimersByTime(64_999));
    expect(onAutoContinue).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onAutoContinue).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(onAutoContinue).toHaveBeenCalledTimes(1);
  });

  it("cancels the timer when unchecked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T02:16:26Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onAutoContinue = vi.fn();
    renderQuotaBanner({ onAutoContinue });
    fireEvent.click(screen.getByRole("checkbox"));

    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it("toggles auto-continue when clicking its caption", () => {
    const onAutoContinue = vi.fn();
    renderQuotaBanner({ onAutoContinue });

    fireEvent.click(screen.getByText("Continue automatically"));

    expect(screen.getByRole("checkbox").getAttribute("data-state")).not.toBe("checked");
  });

  it("waits for persisted settings and initializes from the saved disabled default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T02:16:26Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onAutoContinue = vi.fn();
    const view = renderQuotaBanner({
      autoContinueDefault: true,
      autoContinueReady: false,
      onAutoContinue,
    });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(checkbox.getAttribute("data-state")).not.toBe("checked");
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(onAutoContinue).not.toHaveBeenCalled();

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationQuotaBanner, {
          state: {
            ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
            visible: true,
            kind: "provider-limited",
            providerLimitedBusinessCode: "1308",
            providerLimitedMessage: resetMessage,
            providerLimitedResetAt: Date.parse("2026-10-13T02:16:31Z"),
            dismissible: true,
          },
          onDismiss: vi.fn(),
          autoContinueDefault: false,
          autoContinueReady: true,
          onAutoContinue,
        }),
      ),
    );
    expect(screen.getByRole("checkbox").getAttribute("data-state")).not.toBe("checked");
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it("clears a pending timer when the banner unmounts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-13T02:16:26Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onAutoContinue = vi.fn();
    const view = renderQuotaBanner({ onAutoContinue });
    view.unmount();

    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(onAutoContinue).not.toHaveBeenCalled();
  });

  it("replaces the old timer when the error reset time changes", () => {
    const firstResetAt = Date.parse("2026-10-13T02:16:31Z");
    vi.useFakeTimers();
    vi.setSystemTime(firstResetAt - 5_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onAutoContinue = vi.fn();
    const view = renderQuotaBanner({ onAutoContinue });
    view.rerender(
      quotaBannerElement({
        resetAt: firstResetAt + 120_000,
        onAutoContinue,
      }),
    );

    act(() => vi.advanceTimersByTime(65_000));
    expect(onAutoContinue).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(120_000));
    expect(onAutoContinue).toHaveBeenCalledTimes(1);
  });

  it("preserves the grace period and invokes the latest callback when it changes", () => {
    const resetAt = Date.parse("2026-10-13T02:16:31Z");
    vi.useFakeTimers();
    vi.setSystemTime(resetAt - 5_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const originalCallback = vi.fn();
    const latestCallback = vi.fn();
    const view = renderQuotaBanner({ onAutoContinue: originalCallback });

    act(() => vi.advanceTimersByTime(64_000));
    expect(originalCallback).not.toHaveBeenCalled();
    view.rerender(quotaBannerElement({ onAutoContinue: latestCallback }));
    act(() => vi.advanceTimersByTime(1_000));

    expect(originalCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledTimes(1);
  });
});
