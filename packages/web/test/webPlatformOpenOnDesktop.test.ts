import { describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: renderMock }),
}));

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => children,
  Root: () => null,
  ZCodeIntlProvider: ({ children }: { children: unknown }) => children,
  generateMobileDeviceFingerprint: vi.fn(() => "test-mobile-fingerprint"),
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

async function importCreateWebPlatform() {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: vi.fn() } },
    getElementById: vi.fn(() => ({ nodeType: 1 })),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    matchMedia: () => ({ matches: false }),
    location: { search: "", pathname: "/" },
  });
  vi.stubGlobal("navigator", { language: "en-US" });

  const { createWebPlatform } = await import("../src/main.js");
  return createWebPlatform;
}

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload };
}

const webRemoteControlProxy = {
  token: "token-1",
  relayOrigin: "https://relay.example/",
  windowControlSessionId: "wcs-1",
  mobileConnectionId: "mc-1",
};

describe("createWebPlatform open-on-desktop proxy", () => {
  it("proxies open methods and installed editors to the desktop relay endpoint", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const fetchMock = vi.fn(async () => jsonResponse({ result: { success: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const platform = createWebPlatform({ webRemoteControlProxy });

    await platform.openInFileManager("/workspace/demo");
    await platform.openInEditor("vscode", "/workspace/demo/README.md", { pathKind: "file" });
    await platform.openExternalFile?.("/workspace/demo/report.pdf");
    fetchMock.mockImplementation(async () =>
      jsonResponse({ result: [{ id: "vscode", name: "VS Code", iconDataUrl: "data:" }] }),
    );
    await expect(platform.getInstalledEditors()).resolves.toEqual([
      { id: "vscode", name: "VS Code", iconDataUrl: "data:" },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://relay.example/api/remote-control/platform/token-1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "openInFileManager", args: "/workspace/demo" }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://relay.example/api/remote-control/platform/token-1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "openInEditor",
          args: {
            editorId: "vscode",
            path: "/workspace/demo/README.md",
            options: { pathKind: "file" },
          },
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://relay.example/api/remote-control/platform/token-1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "openExternalFile",
          args: "/workspace/demo/report.pdf",
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://relay.example/api/remote-control/platform/token-1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "getInstalledEditors", args: undefined }),
      },
    );
  });

  it("keeps the plain-web fallbacks when no proxy is configured", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const platform = createWebPlatform();

    await expect(platform.openInFileManager("/workspace/demo")).resolves.toEqual({
      success: false,
      error: "Not supported in web mode",
    });
    await expect(platform.openInEditor("vscode", "/workspace/demo")).resolves.toEqual({
      success: false,
      error: "Not supported in web mode",
    });
    await expect(platform.openExternalFile?.("/workspace/demo")).resolves.toEqual({
      success: false,
      error: "Not supported in web mode",
    });
    await expect(platform.getInstalledEditors()).resolves.toEqual([]);
  });

  it("rejects with the relay error message when the desktop handler fails", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "path not found" }, false));
    vi.stubGlobal("fetch", fetchMock);
    const platform = createWebPlatform({ webRemoteControlProxy });

    await expect(platform.openInFileManager("/workspace/missing")).rejects.toThrow(
      "path not found",
    );
  });
});
