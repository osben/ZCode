// @vitest-environment jsdom

/**
 * OAuth waiting state: "Browser didn't open? Copy login link".
 *
 * The copy row is shown only while waiting for a browser callback and only when the
 * authorization URL that was opened is known. Copying writes that URL to the clipboard and
 * reports the result with a toast.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_OAUTH_CANCEL, TID_OAUTH_COPY_LOGIN_LINK } from "@zcode/shared/test-ids";

const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize?state=flow-state";

const oauthState = vi.hoisted(() => ({
  status: "waiting" as "idle" | "waiting" | "error",
  authorizeUrl: null as string | null,
}));

const toastMock = vi.hoisted(() => vi.fn(() => 1));

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
  dismissToast: vi.fn(),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/hooks/useOAuth.js", () => ({
  useOAuth: () => ({
    startLogin: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    status: oauthState.status,
    error: null,
    authorizeUrl: oauthState.authorizeUrl,
    providers: [{ id: "zai", displayName: "Z.AI", enabled: true, order: 0 }],
    activeProvider: null,
    loadingProviders: false,
    pendingProvider: "zai",
    refreshProviders: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      oauthError: null,
      setOAuthError: vi.fn(),
      oauthSuccessSeq: 0,
      lastOAuthSuccessProvider: null,
      loginEntryRequest: null,
      loginEntryAttempt: null,
      clearLoginEntryRequest: vi.fn(),
      markLoginEntryAttemptStatus: vi.fn(),
    }),
}));

async function renderWelcomeScreen() {
  const { WelcomeScreen } = await import("@/WelcomeScreen.js");
  return render(createElement(WelcomeScreen, { onComplete: vi.fn() }));
}

describe("OAuth waiting state copy login link", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    oauthState.status = "waiting";
    oauthState.authorizeUrl = AUTHORIZE_URL;
    toastMock.mockClear();
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows the fallback hint and copy button after Cancel while waiting for the browser", async () => {
    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
    expect(screen.getByText("login.oauth.browserNotOpened")).toBeTruthy();
    expect(screen.getByTestId(TID_OAUTH_COPY_LOGIN_LINK).textContent).toBe(
      "login.oauth.copyLoginLink",
    );
  });

  it("writes the opened authorization URL to the clipboard and reports success", async () => {
    await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_COPY_LOGIN_LINK));

    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL);
    expect(toastMock).toHaveBeenCalledWith("login.oauth.copyLinkSuccess");
  });

  it("reports failure when the clipboard rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_COPY_LOGIN_LINK));

    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith("login.oauth.copyLinkFailed");
  });

  it("hides the copy row when no authorization URL is known", async () => {
    oauthState.authorizeUrl = null;

    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
    expect(screen.queryByTestId(TID_OAUTH_COPY_LOGIN_LINK)).toBeNull();
    expect(screen.queryByText("login.oauth.browserNotOpened")).toBeNull();
  });
});
