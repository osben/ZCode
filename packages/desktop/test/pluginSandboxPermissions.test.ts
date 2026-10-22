import type { Locale } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { formatPluginSandboxPermissionDialogText } from "../src/main/pluginSandbox/permissions.js";

const input = {
  serverName: "Demo",
  permissions: ["camera", "microphone"] as const,
};

describe("formatPluginSandboxPermissionDialogText", () => {
  it("renders uk-UA copy with Ukrainian labels and buttons", () => {
    expect(formatPluginSandboxPermissionDialogText(input, "uk-UA")).toEqual({
      title: "Запит дозволу застосунку",
      message: "Застосунок «Demo» просить дозволу на використання: камера, мікрофон",
      detail:
        "Ця сторінка працює в пісочниці ZCode. Якщо дозволити, застосунки цього сервера MCP зможуть користуватися цими дозволами, доки ZCode не перезапуститься.",
      allowButton: "Дозволити",
      denyButton: "Відхилити",
    });
  });

  it("keeps uk-UA output free of Chinese characters for every prompted permission", () => {
    const text = formatPluginSandboxPermissionDialogText(
      { serverName: "Demo", permissions: ["camera", "microphone", "geolocation"] },
      "uk-UA",
    );
    expect(text.message).toBe(
      "Застосунок «Demo» просить дозволу на використання: камера, мікрофон, геолокація",
    );
    expect(JSON.stringify(text)).not.toMatch(/[㐀-鿿]/);
  });

  it("keeps zh-CN and en-US copy unchanged", () => {
    expect(formatPluginSandboxPermissionDialogText(input, "zh-CN").message).toBe(
      "「Demo」的应用请求使用摄像头、麦克风",
    );
    expect(formatPluginSandboxPermissionDialogText(input, "zh-CN").allowButton).toBe("允许");
    expect(formatPluginSandboxPermissionDialogText(input, "en-US")).toEqual({
      title: "App permission request",
      message: 'The "Demo" app wants to use your camera, microphone',
      detail:
        "This page runs in the ZCode sandbox. If you allow it, apps from this MCP server can keep using these permissions until ZCode restarts.",
      allowButton: "Allow",
      denyButton: "Deny",
    });
  });

  it("falls back to en-US copy for locales it does not know", () => {
    const unknown = "fr-FR" as Locale;
    expect(formatPluginSandboxPermissionDialogText(input, unknown)).toEqual(
      formatPluginSandboxPermissionDialogText(input, "en-US"),
    );
  });
});
