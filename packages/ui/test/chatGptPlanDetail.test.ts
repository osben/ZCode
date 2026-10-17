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
    startChatGptUsageLink: vi.fn(),
    pollChatGptUsageLink: vi.fn(),
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
  mocks.oauthService.pollChatGptUsageLink.mockReset();
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

  it("renders the passively captured usage line only for accounts that reported one", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        {
          accountKey: "a1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: true,
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
          usage: {
            primary: {
              usedPercent: 42.5,
              windowMinutes: 300,
              resetsAt: "2026-10-15T18:00:00Z",
            },
            secondary: { usedPercent: 7 },
          },
        },
        {
          accountKey: "b1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: true,
          user: { displayName: "Personal", email: "home@example.com", subject: "sub-home" },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    const usageLines = screen.getAllByTestId("chatgpt-plan-usage");
    expect(usageLines).toHaveLength(1);
    // The intl mock returns raw ids, so the segments prove which parts rendered: primary,
    // the reset time, and the weekly window — in that order.
    expect(usageLines[0]?.textContent).toBe(
      [
        "settings.modelProvider.chatgpt.usage.primary",
        "settings.modelProvider.chatgpt.usage.primaryReset",
        "settings.modelProvider.chatgpt.usage.weekly",
      ].join(" · "),
    );
  });

  it("omits the reset segment when resetsAt is absent or unparseable", async () => {
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        {
          accountKey: "a1b2c3d4e5f60718",
          signedIn: true,
          planUsageEntitled: true,
          user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
          usage: { primary: { usedPercent: 13 } },
        },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("chatgpt-plan-usage")?.textContent).toBe(
      "settings.modelProvider.chatgpt.usage.primary",
    );
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

  it("links usage for an entitled account without a linked grant and refreshes status", async () => {
    mocks.oauthService.getChatGptPlanStatus
      .mockResolvedValueOnce({
        accounts: [
          {
            accountKey: "a1b2c3d4e5f60718",
            signedIn: true,
            planUsageEntitled: true,
            user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
          },
        ],
      })
      .mockResolvedValue({
        accounts: [
          {
            accountKey: "a1b2c3d4e5f60718",
            signedIn: true,
            planUsageEntitled: true,
            user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
            usageLinked: true,
            usage: {
              primary: { usedPercent: 17, windowMinutes: 300, resetsAt: "2026-10-17T10:00:00Z" },
            },
          },
        ],
      });
    mocks.oauthService.startChatGptUsageLink.mockResolvedValue({
      authorizeUrl: "https://auth.test/oauth/authorize",
      displayAuthorizeUrl: "https://auth.test/oauth/authorize",
      state: "s",
    });
    let resolvePoll!: (value: { accountKey: string }) => void;
    mocks.oauthService.pollChatGptUsageLink.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    );
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("chatgpt-plan-link-usage")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("chatgpt-plan-link-usage"));
      await Promise.resolve();
    });
    expect(mocks.oauthService.startChatGptUsageLink).toHaveBeenCalledWith("a1b2c3d4e5f60718");
    expect(mocks.platform.openExternal).toHaveBeenCalledWith("https://auth.test/oauth/authorize");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await act(async () => {
      resolvePoll({ accountKey: "a1b2c3d4e5f60718" });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("chatgpt-plan-link-usage")).toBeNull();
    expect(screen.getByTestId("chatgpt-plan-usage")).toBeTruthy();
  });

  it("releases the usage-link pending spinner when a login flow supersedes it", async () => {
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
    mocks.oauthService.startChatGptUsageLink.mockResolvedValue({
      authorizeUrl: "https://auth.test/codex",
      displayAuthorizeUrl: "https://auth.test/codex",
      state: "u",
    });
    // Never settles: the superseding login flow must release the pending UI on its own.
    mocks.oauthService.pollChatGptUsageLink.mockImplementation(() => new Promise(() => {}));
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("chatgpt-plan-link-usage"));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByTestId("chatgpt-plan-link-usage").querySelector("svg")).toBeTruthy();

    // "Add account" stays clickable while a usage link is pending; starting it cancels the
    // usage poll timer, so the new flow must also clear the old flow's spinner. Call history
    // is cleared here because beforeEach only resets the poll mocks, not this starter.
    mocks.oauthService.startChatGptPlanLogin.mockClear();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.addAccount" }),
      );
      await Promise.resolve();
    });
    expect(mocks.oauthService.startChatGptPlanLogin).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chatgpt-plan-link-usage").querySelector("svg")).toBeNull();
  });

  it("a superseded grant flow cannot cancel the newer flow's poll", async () => {
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
    mocks.oauthService.startChatGptUsageLink.mockResolvedValue({
      authorizeUrl: "https://auth.test/codex",
      displayAuthorizeUrl: "https://auth.test/codex",
      state: "u",
    });
    // Flow A (usage link) stalls inside openExternal; the login flow must supersede it entirely.
    let releaseUsageOpen!: () => void;
    mocks.platform.openExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUsageOpen = resolve;
        }),
    );
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("chatgpt-plan-link-usage"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.platform.openExternal).toHaveBeenCalledWith("https://auth.test/codex");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.addAccount" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.platform.openExternal).toHaveBeenCalledWith("https://auth.test");

    // Flow A's browser window finally opens after the login flow took over: it must stop at the
    // generation check instead of cancelling the login poll timer and scheduling its own.
    await act(async () => {
      releaseUsageOpen();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalled();
    expect(mocks.oauthService.pollChatGptUsageLink).not.toHaveBeenCalled();
  });

  it("a superseded grant flow cannot surface a late rejection as the newer flow's error", async () => {
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
    mocks.oauthService.startChatGptUsageLink.mockResolvedValue({
      authorizeUrl: "https://auth.test/codex",
      displayAuthorizeUrl: "https://auth.test/codex",
      state: "u",
    });
    // Flow A (usage link) stalls inside openExternal and later REJECTS; the rejection must die
    // with the superseded flow instead of rendering an error banner over the running login flow.
    let rejectUsageOpen!: (error: Error) => void;
    mocks.platform.openExternal.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectUsageOpen = reject;
        }),
    );
    render(createElement(ChatGptPlanDetail));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("chatgpt-plan-link-usage"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.addAccount" }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectUsageOpen(new Error("stale browser window"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();

    // The login flow's poll timer must survive the superseded flow's rejection.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mocks.oauthService.pollChatGptPlanLogin).toHaveBeenCalledTimes(2);
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
