// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: { name: string }) => values?.name ?? id,
    },
  }),
}));
afterEach(cleanup);

describe("web remote control device navigation", () => {
  it.each([undefined, "", "   "])(
    "missing or empty name %s shows the unnamed device; the entry command runs only on click",
    (deviceName) => {
      const chooseOtherDevice = vi.fn();
      const page = render(
        createElement(WebRemoteControlDeviceHeader, {
          navigation: { deviceName, chooseOtherDevice },
        }),
      );
      expect(page.getByText("webRemoteControl.unnamedDevice")).toBeTruthy();
      expect(chooseOtherDevice).not.toHaveBeenCalled();
      fireEvent.click(page.getByRole("button", { name: "webRemoteControl.switchDevice" }));
      expect(chooseOtherDevice).toHaveBeenCalledOnce();
    },
  );

  it("the whole row is the switch entry: the device name truncates on one line inside the button, with no current-device prefix", () => {
    const chooseOtherDevice = vi.fn();
    const page = render(
      createElement(WebRemoteControlDeviceHeader, {
        navigation: { deviceName: "  Dev Machine  ", chooseOtherDevice },
      }),
    );
    const button = page.getByRole("button", { name: "webRemoteControl.switchDevice" });
    const name = page.getByText("Dev Machine");
    expect(name.textContent).toBe("Dev Machine");
    expect(button.contains(name)).toBe(true);
    expect(name.className).toContain("truncate");
    expect(button.getAttribute("title")).toBe("webRemoteControl.switchDevice");
    expect(button.textContent).toBe("Dev Machine");
    fireEvent.click(name);
    expect(chooseOtherDevice).toHaveBeenCalledOnce();
  });

  it.each([
    ["darwin", "darwin"],
    ["win32", "win32"],
    [undefined, "unknown"],
  ])("platform %s shows the matching device icon %s", (devicePlatform, icon) => {
    const page = render(
      createElement(WebRemoteControlDeviceHeader, {
        navigation: { deviceName: "Mac", devicePlatform, chooseOtherDevice: vi.fn() },
      }),
    );
    const button = page.getByRole("button", { name: "webRemoteControl.switchDevice" });
    expect(button.querySelector(`[data-device-platform-icon="${icon}"]`)).not.toBeNull();
  });
});
