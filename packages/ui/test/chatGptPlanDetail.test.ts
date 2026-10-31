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
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
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

  it("lists every signed-in account with per-account sign out", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        {
          accountKey: "a1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: true,
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
        },
        {
          accountKey: "b1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: false,
          user: { displayName: "Personal", email: "home@example.com", subject: "sub-home" },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    // The intl mock returns raw ids, so account identity is asserted via row actions:
    // two rows render, each with its own sign out, and only the identity-only row
    // (planUsageEntitled=false) offers re-connect.
    expect(
      screen.getAllByRole("button", { name: "settings.modelProvider.chatgpt.signOut" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "settings.modelProvider.chatgpt.reconnect" }),
    ).toBeTruthy();

    const signOutButtons = screen.getAllByRole("button", {
      name: "settings.modelProvider.chatgpt.signOut",
    });
    await act(async () => {
      fireEvent.click(signOutButtons[0]!);
      await Promise.resolve();
    });
    expect(mocks.oauthService.logoutChatGptPlan).toHaveBeenCalledWith("a1b2c3d4e5f60718");
  });

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  // specs/chatgpt-plan-signin.md "Usage limits" and L3: official surface only, no usage UI.
  it("shows no usage block, plan badge or Link usage for a signed-in account", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        {
          accountKey: "a1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: true,
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await flush();

    expect(screen.getByText("settings.modelProvider.chatgpt.signedInAs")).toBeTruthy();
    expect(screen.queryByTestId("chatgpt-plan-usage")).toBeNull();
    expect(screen.queryByTestId("chatgpt-plan-type")).toBeNull();
    expect(screen.queryByTestId("chatgpt-plan-link-usage")).toBeNull();
    expect(
      screen.getByRole("button", { name: "settings.modelProvider.chatgpt.manageUsage" }),
    ).toBeTruthy();
  });

  it("shows a reconnect row for an account whose sign-in expired", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [],
      reconnectRequired: [
        {
          accountKey: "a1b2c3d4e5f60718",
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await flush();

    expect(screen.getByTestId("chatgpt-plan-reconnect-row")).toBeTruthy();
    expect(screen.queryByText("settings.modelProvider.chatgpt.notSignedIn")).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.signInAgain" }),
      );
      await Promise.resolve();
    });
    expect(mocks.oauthService.startChatGptPlanLogin).toHaveBeenCalledWith({
      reauthAccountKey: "a1b2c3d4e5f60718",
    });
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

    const dialog = screen.getByRole("dialog", {
      name: "settings.modelProvider.chatgpt.firstRun.title",
    });
    expect(dialog).toBeTruthy();

    // The shared Dialog closes on Escape (the old overlay could only be closed with "Got it").
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("re-authorizes the targeted account from its row's Re-connect button", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        {
          accountKey: "a1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: false,
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.reconnect" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // A dropped reauthAccountKey would fall back to the full account-chooser login.
    expect(mocks.oauthService.startChatGptPlanLogin).toHaveBeenCalledWith({
      reauthAccountKey: "a1b2c3d4e5f60718",
    });
  });
});
