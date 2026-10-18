import { describe, expect, it } from "vitest";

describe("desktop deep link url helpers", () => {
  it("recognizes only the unified OAuth callback url", async () => {
    const { isOAuthCallbackUrl } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(isOAuthCallbackUrl(new URL("zcode://oauth/callback?code=1&state=s"))).toBe(true);
    expect(isOAuthCallbackUrl(new URL("zcode://bigmodel-auth/callback?authCode=1&state=s"))).toBe(
      false,
    );
    expect(isOAuthCallbackUrl(new URL("zcode://zai-auth/callback?code=1&state=s"))).toBe(false);
    expect(isOAuthCallbackUrl(new URL("zcode://oauth/other?code=1&state=s"))).toBe(false);
    expect(isOAuthCallbackUrl(new URL("https://oauth/callback?code=1&state=s"))).toBe(false);
  });

  it("accepts Linux one-slash callback urls", async () => {
    const { isOAuthCallbackUrl, isPaymentCallbackUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");

    expect(isOAuthCallbackUrl(new URL("zcode:/oauth/callback?code=1&state=s"))).toBe(true);
    expect(isOAuthCallbackUrl(new URL("zcode:oauth/callback?code=1&state=s"))).toBe(true);
    expect(isPaymentCallbackUrl(new URL("zcode:/payment/callback?status=return"))).toBe(true);
    expect(isPaymentCallbackUrl(new URL("zcode:payment/callback?status=cancel"))).toBe(true);
  });

  it("recognizes payment callback urls separately from OAuth", async () => {
    const { isOAuthCallbackUrl, isPaymentCallbackUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");

    const paymentUrl = new URL("zcode://payment/callback?provider=zai&channel=paypal");
    expect(isPaymentCallbackUrl(paymentUrl)).toBe(true);
    expect(isOAuthCallbackUrl(paymentUrl)).toBe(false);
    expect(isPaymentCallbackUrl(new URL("zcode://payment/other"))).toBe(false);
  });

  it("recognizes workspace open urls and extracts the encoded folder path", async () => {
    const { extractWorkspaceOpenPath, isWorkspaceOpenUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");

    const workspaceUrl = new URL("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%20A%26B");
    expect(isWorkspaceOpenUrl(workspaceUrl)).toBe(true);
    expect(extractWorkspaceOpenPath(workspaceUrl)).toBe("/Users/demo/Project A&B");
    expect(isWorkspaceOpenUrl(new URL("zcode://workspace/other?path=%2Ftmp"))).toBe(false);
    expect(extractWorkspaceOpenPath(new URL("zcode://workspace/open"))).toBeNull();
  });

  it("只接受不含额外敏感参数的 share import code", async () => {
    const { extractShareImportCode, isShareImportUrl } =
      await import("../src/main/desktopDeepLinkUrl.js");
    const valid = new URL("zcode://share/import?code=abc_DEF-123");
    expect(isShareImportUrl(valid)).toBe(true);
    expect(extractShareImportCode(valid)).toBe("abc_DEF-123");
    expect(extractShareImportCode(new URL("zcode://share/import"))).toBeNull();
    expect(extractShareImportCode(new URL("zcode://share/import?code=bad%2Fcode"))).toBeNull();
    expect(isShareImportUrl(new URL("https://share/import?code=abc"))).toBe(false);
  });

  it("extracts protocol urls from desktop argv variants", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://oauth/callback?code=1&state=s"]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "--open-url=zcode://oauth/callback?code=1&state=s",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%3A%2F%2Foauth%2Fcallback%3Fcode%3D1%26state%3Ds",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode%253A%252F%252Foauth%252Fcallback%253Fcode%253D1%2526state%253Ds",
      ]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://oauth/callback?code=1", "&state=s"]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "zcode://oauth/callback?code=1&amp;state=s"]),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromArgs([
        "/opt/ZCode/zcode",
        "zcode://payment/callback?provider=zai",
        "&channel=paypal",
        "&status=return",
      ]),
    ).toBe("zcode://payment/callback?provider=zai&channel=paypal&status=return");
    expect(
      extractDeepLinkUrlFromArgs([
        "/Applications/ZCode.app/Contents/MacOS/ZCode",
        "zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A",
      ]),
    ).toBe("zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A");
  });

  it("returns null when argv does not contain a deep link", async () => {
    const { extractDeepLinkUrlFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(extractDeepLinkUrlFromArgs(["/opt/ZCode/zcode", "--no-sandbox"])).toBeNull();
  });

  it("extracts Windows open workspace argv without URL decoding", async () => {
    const { extractOpenWorkspacePathFromArgs } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace",
        "C:\\Users\\demo\\Project A&B#1",
      ]),
    ).toBe("C:\\Users\\demo\\Project A&B#1");
    expect(
      extractOpenWorkspacePathFromArgs([
        "C:\\Program Files\\ZCode\\ZCode.exe",
        "--open-workspace=C:\\Users\\demo\\Project%20A",
      ]),
    ).toBe("C:\\Users\\demo\\Project%20A");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:"'])).toBe("C:\\");
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace", 'C:\\repo"'])).toBe(
      "C:\\repo\\",
    );
    expect(extractOpenWorkspacePathFromArgs(["ZCode.exe", "--open-workspace"])).toBeNull();
  });

  it("passes parsed deep links through single instance additionalData", async () => {
    const {
      createDeepLinkSingleInstanceData,
      extractDeepLinkUrlFromSingleInstanceData,
      extractOpenWorkspacePathFromSingleInstanceData,
    } = await import("../src/main/desktopDeepLinkUrl.js");

    const additionalData = createDeepLinkSingleInstanceData([
      "/opt/ZCode/zcode",
      "zcode%253A%252F%252Foauth%252Fcallback%253Fcode%253D1%2526state%253Ds",
      "--open-workspace=C:\\Users\\demo\\Project A",
    ]);

    expect(extractDeepLinkUrlFromSingleInstanceData(additionalData)).toBe(
      "zcode://oauth/callback?code=1&state=s",
    );
    expect(extractOpenWorkspacePathFromSingleInstanceData(additionalData)).toBe(
      "C:\\Users\\demo\\Project A",
    );
    expect(extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: "https://example.com" })).toBe(
      null,
    );
  });

  it("percent-encodes single instance payload values so no whitespace or non-ASCII bytes reach Chromium", async () => {
    // Electron #52020: Chromium splits the serialized additionalData on NUL and trims whitespace,
    // so raw values with spaces or non-ASCII bytes can corrupt the handshake. Keep the payload ASCII-only.
    const { createDeepLinkSingleInstanceData, extractOpenWorkspacePathFromSingleInstanceData } =
      await import("../src/main/desktopDeepLinkUrl.js");
    const workspacePath = "/tmp/проект с пробелами ü";

    const additionalData = createDeepLinkSingleInstanceData([
      "/opt/ZCode/zcode",
      "--open-workspace",
      workspacePath,
    ]);

    const values = Object.values(additionalData);
    expect(values).toHaveLength(1);
    for (const value of values) {
      expect(value).not.toMatch(/\s/);
      expect(Buffer.from(value, "utf8").every((byte) => byte < 0x80)).toBe(true);
    }
    expect(extractOpenWorkspacePathFromSingleInstanceData(additionalData)).toBe(workspacePath);
  });

  it("round-trips deep link urls through single instance payload without corrupting escapes", async () => {
    const { createDeepLinkSingleInstanceData, extractDeepLinkUrlFromSingleInstanceData } =
      await import("../src/main/desktopDeepLinkUrl.js");

    const workspaceUrl = "zcode://workspace/open?path=%2FUsers%2Fdemo%2FProject%2520A";
    const workspaceData = createDeepLinkSingleInstanceData(["/opt/ZCode/zcode", workspaceUrl]);
    expect(Object.values(workspaceData).every((value) => !/\s/.test(value))).toBe(true);
    expect(extractDeepLinkUrlFromSingleInstanceData(workspaceData)).toBe(workspaceUrl);

    const oauthUrl = "zcode://oauth/callback?code=1&state=ü";
    const oauthData = createDeepLinkSingleInstanceData(["/opt/ZCode/zcode", oauthUrl]);
    expect(
      Object.values(oauthData).every((value) => Buffer.from(value, "utf8").every((b) => b < 0x80)),
    ).toBe(true);
    expect(extractDeepLinkUrlFromSingleInstanceData(oauthData)).toBe(oauthUrl);
  });

  it("passes legacy unencoded single instance values through unchanged", async () => {
    // Values written before the encoding existed. A stray "%" makes decodeURIComponent throw,
    // so the raw value must be used as-is instead of being dropped.
    const {
      extractDeepLinkUrlFromSingleInstanceData,
      extractOpenWorkspacePathFromSingleInstanceData,
    } = await import("../src/main/desktopDeepLinkUrl.js");

    expect(extractOpenWorkspacePathFromSingleInstanceData({ openWorkspacePath: "/tmp/100%" })).toBe(
      "/tmp/100%",
    );
    expect(
      extractOpenWorkspacePathFromSingleInstanceData({ openWorkspacePath: "/tmp/plain path" }),
    ).toBe("/tmp/plain path");
    expect(
      extractOpenWorkspacePathFromSingleInstanceData({
        openWorkspacePath: "/tmp/проект с пробелами ü",
      }),
    ).toBe("/tmp/проект с пробелами ü");
    expect(
      extractDeepLinkUrlFromSingleInstanceData({
        deepLinkUrl: "zcode://oauth/callback?code=1&state=s",
      }),
    ).toBe("zcode://oauth/callback?code=1&state=s");
    expect(
      extractDeepLinkUrlFromSingleInstanceData({
        deepLinkUrl: "zcode://oauth/callback?code=100%&state=s",
      }),
    ).toBe("zcode://oauth/callback?code=100%&state=s");
  });

  it("builds Windows Explorer registry operations for folder context menu", async () => {
    const { buildWindowsOpenFolderCommand, buildWindowsOpenFolderRegistryOperations } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(buildWindowsOpenFolderCommand("C:\\Program Files\\ZCode\\ZCode.exe")).toBe(
      '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
    );
    expect(
      buildWindowsOpenFolderCommand("C:\\Electron\\electron.exe", ["C:\\repo\\desktop\\main.js"]),
    ).toBe('"C:\\Electron\\electron.exe" "C:\\repo\\desktop\\main.js" --open-workspace "%1"');

    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "en-US",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Drive\\shell\\ZCode.OpenInZCode\\command",
        "/ve",
        "/d",
        '"C:\\Program Files\\ZCode\\ZCode.exe" --open-workspace "%1"',
        "/f",
      ],
    });
  });

  it("builds localized Windows Explorer registry menu labels", async () => {
    const { buildWindowsOpenFolderRegistryOperations, getWindowsOpenFolderMenuName } =
      await import("../src/main/desktopWindowsOpenFolderContextMenu.js");

    expect(getWindowsOpenFolderMenuName("zh-CN")).toBe("在ZCode中打开");
    expect(getWindowsOpenFolderMenuName("en-US")).toBe("Open in ZCode");

    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
      locale: "zh-CN",
    });

    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode",
        "/ve",
        "/d",
        "在ZCode中打开",
        "/f",
      ],
    });
    expect(operations).toContainEqual({
      args: [
        "add",
        "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode",
        "/v",
        "MUIVerb",
        "/t",
        "REG_SZ",
        "/d",
        "在ZCode中打开",
        "/f",
      ],
    });
  });
});
