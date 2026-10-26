// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  oauthService: {
    getChatGptPlanStatus: vi.fn(),
    refreshChatGptPlanUsage: vi.fn(),
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
  // By default the usage refresh returns whatever the status read currently returns.
  mocks.oauthService.refreshChatGptPlanUsage.mockReset();
  mocks.oauthService.refreshChatGptPlanUsage.mockImplementation(() =>
    mocks.oauthService.getChatGptPlanStatus(),
  );
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

  // specs/chatgpt-plan-signin.md "Usage display (Settings)".
  const NOW = Date.parse("2026-10-15T15:56:50Z");
  const account = (usage?: Record<string, unknown>) => ({
    accountKey: "a1b2c3d4e5f60718",
    signedIn: true,
    planUsageEntitled: true,
    usageLinked: true,
    user: { displayName: "Work", email: "work@example.com", subject: "sub-work" },
    ...(usage ? { usage } : {}),
  });
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("renders each window with its label, share left, severity and reset countdown (U2, U3)", async () => {
    vi.setSystemTime(NOW);
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        account({
          planType: "plus",
          capturedAt: new Date(NOW).toISOString(),
          primary: { usedPercent: 42, windowMinutes: 300, resetsAt: "2026-10-15T18:00:00Z" },
          secondary: { usedPercent: 75, windowMinutes: 10080, resetsAt: "2026-10-18T16:00:00Z" },
        }),
        { ...account(), accountKey: "b1b2c3d4e5f60718", usageLinked: false },
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await flush();

    expect(screen.getAllByTestId("chatgpt-plan-usage")).toHaveLength(1);
    const [primary, secondary] = screen.getAllByTestId("chatgpt-plan-usage-window");
    expect(primary?.getAttribute("data-severity")).toBe("normal");
    expect(primary?.textContent).toContain("settings.modelProvider.chatgpt.usage.window.fiveHour");
    expect(primary?.querySelector("[role=meter]")?.getAttribute("aria-valuenow")).toBe("58");
    expect(primary?.textContent).toContain("settings.modelProvider.chatgpt.usage.resetsIn");
    expect(secondary?.getAttribute("data-severity")).toBe("warning");
    expect(secondary?.textContent).toContain("settings.modelProvider.chatgpt.usage.window.weekly");
    expect(screen.getByTestId("chatgpt-plan-type").textContent).toBe("Plus");
    expect(screen.queryByTestId("chatgpt-plan-usage-stale")).toBeNull();
  });

  it("shows reset-pending, stale and limit-reached states (U4, U5, U6)", async () => {
    vi.setSystemTime(NOW);
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [
        account({
          limitReached: true,
          capturedAt: new Date(NOW - 7 * 60_000).toISOString(),
          primary: { usedPercent: 100, resetsAt: "2026-10-15T15:00:00Z" },
          secondary: { usedPercent: 95 },
        }),
      ],
    });
    render(createElement(ChatGptPlanDetail));
    await flush();

    const [primary, secondary] = screen.getAllByTestId("chatgpt-plan-usage-window");
    expect(primary?.textContent).toContain("settings.modelProvider.chatgpt.usage.resetPending");
    expect(primary?.querySelector("[role=meter]")).toBeNull();
    expect(secondary?.getAttribute("data-severity")).toBe("critical");
    expect(screen.getByTestId("chatgpt-plan-usage-stale")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "settings.modelProvider.chatgpt.usage.limitReached",
    );
  });

  it("lists accounts before the usage probe settles, then shows the refreshed usage (U1)", async () => {
    let resolveRefresh!: (value: unknown) => void;
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({ accounts: [account()] });
    mocks.oauthService.refreshChatGptPlanUsage.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRefresh = resolve)),
    );
    render(createElement(ChatGptPlanDetail));
    await flush();

    expect(screen.getByText("settings.modelProvider.chatgpt.signedInAs")).toBeTruthy();
    expect(screen.queryByTestId("chatgpt-plan-usage")).toBeNull();

    await act(async () => {
      resolveRefresh({ accounts: [account({ primary: { usedPercent: 10 } })] });
    });
    expect(screen.getByTestId("chatgpt-plan-usage")).toBeTruthy();
  });

  it("keeps the newer status when an older refresh settles last, and keeps usage on failure (U8, U10)", async () => {
    let resolveStale!: (value: unknown) => void;
    mocks.oauthService.getChatGptPlanStatus.mockResolvedValue({
      accounts: [account({ primary: { usedPercent: 10 } })],
    });
    mocks.oauthService.refreshChatGptPlanUsage
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
      .mockRejectedValueOnce(new Error("probe failed"));
    render(createElement(ChatGptPlanDetail));
    await flush();

    // A newer read (window focus refresh) fails: the shown usage stays.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("chatgpt-plan-usage")).toBeTruthy();

    // The older refresh settles last with no usage: it must not overwrite the newer read.
    await act(async () => {
      resolveStale({ accounts: [account()] });
    });
    expect(screen.getByTestId("chatgpt-plan-usage")).toBeTruthy();
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
    // The open-time usage refresh still sees the unlinked account.
    mocks.oauthService.refreshChatGptPlanUsage.mockResolvedValueOnce({
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
