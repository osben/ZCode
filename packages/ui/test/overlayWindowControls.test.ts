// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DesktopCommandIds } from "@zcode/shared";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";

const { executeDesktopCommand } = vi.hoisted(() => ({
  executeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("升级和奖励的网页关闭与窗口关闭分开，三种窗口操作走现有命令", () => {
  const onClose = vi.fn();
  render(
    createElement(EmbeddedWebsiteHeader, {
      title: "Rewards",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onReload: vi.fn(),
      onClose,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "common.close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(executeDesktopCommand).not.toHaveBeenCalled();
  for (const [id, command] of [
    ["minimize", DesktopCommandIds.MinimizeWindow],
    ["maximize", DesktopCommandIds.ToggleMaximizeWindow],
    ["close", DesktopCommandIds.CloseWindow],
  ]) {
    fireEvent.click(screen.getByTestId(`window-control-${id}`));
    expect(executeDesktopCommand).toHaveBeenLastCalledWith(command);
  }
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("登录、升级、奖励均接入覆盖层窗控", async () => {
  const read = (file: string) => readFile(resolve(__dirname, "../src", file), "utf8");
  expect(await read("WelcomeScreen.tsx")).toContain("<DesktopOverlayWindowControls />");
  for (const file of [
    "rewards/RewardsWebview.tsx",
    "settings/CodingPlanEmbeddedWebviewDialog.tsx",
  ]) {
    expect(await read(file)).toContain("<EmbeddedWebsiteHeader");
  }
});
