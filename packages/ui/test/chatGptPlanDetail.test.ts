// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  oauthService: {
    getChatGptPlanStatus: vi.fn(),
    startChatGptPlanLogin: vi.fn(),
    pollChatGptPlanLogin: vi.fn(),
    logoutChatGptPlan: vi.fn(),
  },
  platform: { openExternal: vi.fn() },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ oauthService: mocks.oauthService }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => mocks.platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

import { ChatGptPlanDetail } from "../src/settings/model-provider-section/ChatGptPlanDetail.js";

const signedOut = { signedIn: false, planUsageEntitled: false };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.oauthService.getChatGptPlanStatus.mockResolvedValue(signedOut);
  mocks.oauthService.startChatGptPlanLogin.mockResolvedValue({ authorizeUrl: "https://auth.test" });
  mocks.oauthService.pollChatGptPlanLogin.mockReset();
  mocks.oauthService.logoutChatGptPlan.mockResolvedValue(undefined);
  mocks.platform.openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatGptPlanDetail", () => {
  it("serializes login polls and ignores an in-flight completion after unmount", async () => {
    let resolveFirst!: (value: null) => void;
    let resolveSecond!: (value: {
      signedIn: true;
      planUsageEntitled: true;
      newUser: true;
      user: { subject: string };
    }) => void;
    mocks.oauthService.pollChatGptPlanLogin
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { unmount } = render(createElement(ChatGptPlanDetail));

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings.modelProvider.chatgpt.continueWithChatgpt",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(null);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      resolveSecond({
        signedIn: true,
        planUsageEntitled: true,
        newUser: true,
        user: { subject: "test-user" },
      });
      await Promise.resolve();
    });
    expect(localStorage.getItem("zcode.chatgptPlan.firstRunModalShown")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(2);
  });

  it("gives the first-run dialog an accessible name", async () => {
    mocks.oauthService.pollChatGptPlanLogin.mockResolvedValue({
      signedIn: true,
      planUsageEntitled: true,
      newUser: true,
      user: { subject: "test-user" },
    });
    render(createElement(ChatGptPlanDetail));

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings.modelProvider.chatgpt.continueWithChatgpt",
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(
      screen.getByRole("dialog", { name: "settings.modelProvider.chatgpt.firstRun.title" }),
    ).toBeTruthy();
  });
});
