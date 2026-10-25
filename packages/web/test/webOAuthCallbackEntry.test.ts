// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://zcode.z.ai/"}
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => [] as Root[]);

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: () => null,
  Root: () => null,
  ZCodeIntlProvider: () => null,
  Button: () => null,
  generateMobileDeviceFingerprint: () => "oauth-entry-test",
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

vi.mock("@web/share/ConversationShareLandingPage.js", () => ({
  ConversationShareLandingLoader: () => "share-preview",
  ConversationShareLandingStatus: () => "invalid-share",
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.lang = "en";
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function bootstrap(path: string, query: string) {
  window.history.replaceState(null, "", `${path}?${query}`);
  const { WebAuthService } = await import("@web/auth/webAuthService.js");
  // Keep the real entry and callback component effects; the nonce/token contract inside the service is covered by webAuthService.test.
  const handleCallback = vi
    .spyOn(WebAuthService.prototype, "handleCallback")
    .mockResolvedValue(null);
  await act(async () => {
    await import("@web/main.js");
  });
  return handleCallback;
}

describe("Web OAuth callback entry", () => {
  for (const path of ["/share/callback", "/cn/share/callback", "/remote/v4", "/remote/v4/"]) {
    it.each(["authCode=bigmodel-code", "code=zai-code", "error=access_denied"])(
      `${path} for %s renders the callback page and hands off to the auth service`,
      async (result) => {
        const handleCallback = await bootstrap(path, `state=entry-state&${result}`);
        expect(document.body.textContent).toContain("Finishing Sign-In");
        expect(handleCallback).toHaveBeenCalledExactlyOnceWith(window.location.href);
      },
    );
  }

  for (const path of ["/share/callback", "/cn/share/callback"]) {
    it.each(["authCode=code", "code=code", "error=access_denied", "state=entry-state"])(
      `${path} without state or result parameters does not enter the callback page: %s`,
      async (query) => {
        const handleCallback = await bootstrap(path, query);
        expect(handleCallback).not.toHaveBeenCalled();
        expect(document.body.textContent).toBe("share-preview");
      },
    );
  }

  it("a normal share path keeps the preview route even when it carries OAuth parameters", async () => {
    const handleCallback = await bootstrap("/share/example", "state=entry-state&authCode=code");
    expect(handleCallback).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("share-preview");
  });
});
