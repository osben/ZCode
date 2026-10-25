// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EmbeddedBrowserPermissionPromptEvent } from "@zcode/shared";
import {
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_ALLOW_ONCE,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_DISMISS,
  TID_BROWSER_PERMISSION_PROMPTS,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// Same "@/..." specifier as the component: under the vitest alias a relative path and the alias
// resolve to two module instances, putting setState and the component subscription on different stores.
import { useEmbeddedBrowserPermissionStore } from "@/store/embeddedBrowserPermissionStore.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

/** Simulates main pushing a hot device-list update: pushes with the same requestId replace the list instead of appending. */
function pushDeviceListUpdate(
  requestId: string,
  devices: Array<{ deviceId: string; name?: string }>,
) {
  useEmbeddedBrowserPermissionStore.getState().receivePrompt({
    requestId,
    kind: "device",
    origin: "https://example.com",
    permission: "select-bluetooth-device",
    devices,
  });
}

const resolveEmbeddedBrowserPermissionPrompt = vi.fn();

// The real platform is a stable singleton; if the mock returned a fresh object each render, the load effect's dependencies would break.
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    onEmbeddedBrowserPermissionPrompt: () => () => undefined,
    resolveEmbeddedBrowserPermissionPrompt,
  }),
}));

const { EmbeddedBrowserPermissionPrompts } =
  await import("@/browser-use/EmbeddedBrowserPermissionPrompts.js");

function renderWithPrompts(
  prompts: EmbeddedBrowserPermissionPromptEvent[],
  guestWebContentsId?: number,
) {
  useEmbeddedBrowserPermissionStore.setState({ prompts });
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(EmbeddedBrowserPermissionPrompts, { guestWebContentsId }),
    ),
  );
}

const permissionPrompt: EmbeddedBrowserPermissionPromptEvent = {
  requestId: "req-1",
  kind: "permission",
  origin: "https://example.com",
  permission: "media",
  mediaTypes: ["video"],
};

beforeEach(() => {
  useEmbeddedBrowserPermissionStore.setState({ prompts: [] });
  resolveEmbeddedBrowserPermissionPrompt.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("EmbeddedBrowserPermissionPrompts Chrome-style permission bubble", () => {
  it("does not render the bubble when there is no request", () => {
    renderWithPrompts([]);
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("renders origin, per-mediaTypes capability names and deny/allow/✕ buttons", () => {
    renderWithPrompts([permissionPrompt]);
    expect(screen.getByText("https://example.com")).toBeTruthy();
    // mediaTypes: ["video"] → camera, not the generic "camera and microphone"
    expect(screen.getByText(expectedCopy("browser.permission.mediaVideo"))).toBeTruthy();
    expect(screen.queryByText(expectedCopy("browser.permission.media"))).toBeNull();
    // Three stacked options: don't allow / allow once / allow on every visit
    expect(
      screen.getByRole("button", { name: expectedCopy("browser.permission.denyThisTime") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: expectedCopy("browser.permission.allowOnce") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: expectedCopy("browser.permission.allowAlways") }),
    ).toBeTruthy();
    // The bubble header has an ✕ close (= don't allow this time); still no "block forever"
    expect(
      screen.queryByRole("button", { name: expectedCopy("browser.permission.blockAlways") }),
    ).toBeNull();
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_DISMISS)).toBeTruthy();
  });

  it("clipboard-read shows clipboard reading", () => {
    renderWithPrompts([
      { ...permissionPrompt, permission: "clipboard-read", mediaTypes: undefined },
    ]);
    expect(screen.getByText(expectedCopy("browser.permission.clipboardRead"))).toBeTruthy();
  });

  it('"allow once" reports allow-session and dequeues', () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_ALLOW_ONCE));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "allow-session" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it('"allow on this site" reports allow-always', () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_ALLOW_ALWAYS));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "allow-always" },
    });
  });

  it('"don\'t allow" reports dismiss (deny this time, not remembered)', () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_DENY));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "dismiss" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("permission requests are filtered by guest ownership: a background tab's request does not render in the current tab", () => {
    // Current tab's guest id = 42; the request comes from 99 (background tab)
    renderWithPrompts([{ ...permissionPrompt, guestWebContentsId: 99 }], 42);
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();

    // The request comes from the current tab (42): render
    cleanup();
    renderWithPrompts([{ ...permissionPrompt, guestWebContentsId: 42 }], 42);
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeTruthy();
    expect(screen.getByText("https://example.com")).toBeTruthy();

    // The request has no owning id (fallback path): render, with origin marking the source
    cleanup();
    renderWithPrompts([permissionPrompt], 42);
    expect(screen.getByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeTruthy();

    // The current tab has no guest (empty tab): again only fallback requests render
    cleanup();
    renderWithPrompts([{ ...permissionPrompt, guestWebContentsId: 99 }], undefined);
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("✕ close reports dismiss (deny this time, not remembered)", () => {
    renderWithPrompts([permissionPrompt]);
    fireEvent.click(screen.getByTestId(TID_BROWSER_PERMISSION_DISMISS));
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-1",
      resolution: { action: "dismiss" },
    });
    expect(screen.queryByTestId(TID_BROWSER_PERMISSION_PROMPTS)).toBeNull();
  });

  it("media requesting camera and microphone at once lists two capability rows", () => {
    renderWithPrompts([{ ...permissionPrompt, mediaTypes: ["video", "audio"] }]);
    expect(screen.getByText(expectedCopy("browser.permission.mediaVideo"))).toBeTruthy();
    expect(screen.getByText(expectedCopy("browser.permission.mediaAudio"))).toBeTruthy();
    expect(screen.queryByText(expectedCopy("browser.permission.media"))).toBeNull();
  });

  it("different requests can render side by side", () => {
    renderWithPrompts([
      permissionPrompt,
      { ...permissionPrompt, requestId: "req-2", permission: "geolocation" },
    ]);
    expect(screen.getByText(expectedCopy("browser.permission.mediaVideo"))).toBeTruthy();
    expect(screen.getByText(expectedCopy("browser.permission.geolocation"))).toBeTruthy();
  });
});

describe("EmbeddedBrowserPermissionPrompts picker dialogs", () => {
  it("screen-share dialog groups sources by Entire Screen / Window", () => {
    renderWithPrompts([
      {
        requestId: "req-share",
        kind: "screen-share",
        origin: "https://meet.example.com",
        screens: [
          {
            sourceId: "screen:1",
            name: "Main Display",
            kind: "screen",
            thumbnailDataUrl: "data:image/jpeg;base64,AAAA",
          },
          { sourceId: "window:2", name: "Doc — Preview", kind: "window" },
          { sourceId: "window:3", name: "Terminal", kind: "window" },
        ],
      },
    ]);
    // The title has an ICU interpolation ({origin} wants to share your screen); assert by textContent inclusion
    expect(
      screen.getAllByText(
        (_, element) => element?.textContent?.includes("https://meet.example.com") ?? false,
      ).length,
    ).toBeGreaterThan(0);
    // Group headings
    expect(screen.getByText(expectedCopy("browser.permission.screenGroup.screen"))).toBeTruthy();
    expect(screen.getByText(expectedCopy("browser.permission.screenGroup.window"))).toBeTruthy();
    expect(screen.getByText("Doc — Preview")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: expectedCopy("browser.permission.share") }),
    ).toBeTruthy();
  });

  it("pushes with the same requestId hot-update the device list (bluetooth scan finds devices progressively)", async () => {
    renderWithPrompts([
      {
        requestId: "req-bt",
        kind: "device",
        origin: "https://example.com",
        permission: "select-bluetooth-device",
        devices: [],
      },
    ]);
    // First scan is empty: no devices in the list
    expect(screen.queryByText("Headphones")).toBeNull();

    pushDeviceListUpdate("req-bt", [{ deviceId: "bt-1", name: "Headphones" }]);
    await waitFor(() => expect(screen.getByText("Headphones")).toBeTruthy());
  });

  it("device picker lists device names with vendor/serial metadata and disables Connect until a selection is made", () => {
    renderWithPrompts([
      {
        requestId: "req-device",
        kind: "device",
        origin: "https://example.com",
        permission: "select-hid-device",
        devices: [
          {
            deviceId: "dev-1",
            name: "Ledger Nano",
            vendorId: 0x2c97,
            productId: 0x0001,
            serialNumber: "SN123",
          },
        ],
      },
    ]);
    expect(screen.getByText("Ledger Nano")).toBeTruthy();
    expect(screen.getByText("2c97:0001 · SN123")).toBeTruthy();

    const connectButton = screen.getByRole("button", {
      name: expectedCopy("browser.permission.connect"),
    });
    expect((connectButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Ledger Nano"));
    expect((connectButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(connectButton);
    expect(resolveEmbeddedBrowserPermissionPrompt).toHaveBeenCalledWith({
      requestId: "req-device",
      resolution: { action: "select-device", deviceId: "dev-1" },
    });
  });
});
