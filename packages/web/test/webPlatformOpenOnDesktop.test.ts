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
    location: {
      search: "",
      pathname: "/",
      href: "https://zcode.z.ai/",
      origin: "https://zcode.z.ai",
    },
  });
  vi.stubGlobal("navigator", { language: "en-US" });

  const { createWebPlatform } = await import("../src/platform/index.js");
  return createWebPlatform;
}

// Relay V2: open and editor methods are forwarded through the desktop platform proxy
// (`requestPlatformMethod` over the paired relay). The former V1 HTTP `/api/remote-control/platform`
// endpoint is gone with the V1 transport.
function createPlatformProxy() {
  const requestPlatformMethod = vi.fn(async (method: string, _args?: unknown) => {
    if (method === "getInstalledEditors") {
      return [{ id: "vscode", name: "VS Code", iconDataUrl: "data:" }];
    }
    return { success: true };
  });
  return { requestPlatformMethod, reportTelemetryEvent: vi.fn() };
}

describe("createWebPlatform open-on-desktop proxy", () => {
  it("proxies open methods and installed editors to the desktop through the relay", async () => {
    const createWebPlatform = await importCreateWebPlatform();
    const proxy = createPlatformProxy();
    const platform = createWebPlatform({ externalWebRemoteControlProxy: proxy });

    await platform.openInFileManager("/workspace/demo");
    await platform.openInEditor("vscode", "/workspace/demo/README.md", { pathKind: "file" });
    await platform.openExternalFile?.("/workspace/demo/report.pdf");
    await expect(platform.getInstalledEditors()).resolves.toEqual([
      { id: "vscode", name: "VS Code", iconDataUrl: "data:" },
    ]);

    expect(proxy.requestPlatformMethod.mock.calls).toEqual([
      ["openInFileManager", "/workspace/demo"],
      [
        "openInEditor",
        {
          editorId: "vscode",
          path: "/workspace/demo/README.md",
          options: { pathKind: "file" },
        },
      ],
      ["openExternalFile", "/workspace/demo/report.pdf"],
      ["getInstalledEditors"],
    ]);
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
    const proxy = createPlatformProxy();
    proxy.requestPlatformMethod.mockRejectedValueOnce(new Error("path not found"));
    const platform = createWebPlatform({ externalWebRemoteControlProxy: proxy });

    await expect(platform.openInFileManager("/workspace/missing")).rejects.toThrow(
      "path not found",
    );
  });
});
