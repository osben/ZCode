// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlFailureScreen,
} from "#src/web-remote-control/views.js";

afterEach(cleanup);

describe("manual account switch confirmation", () => {
  const locale = "en-US" as const;
  it.each(["devices", "failure"])(
    "%s cancel keeps the sign-in; only confirm signs out",
    async (source) => {
      const onSwitch = vi.fn();
      const label = "Switch account";
      render(
        source === "devices"
          ? createElement(WebRemoteControlDeviceListPage, {
              locale,
              view: { kind: "devices", devices: [], loading: false, error: false },
              onSwitchAccount: onSwitch,
              onRefresh: vi.fn(),
              onSelect: vi.fn(),
            })
          : createElement(WebRemoteControlFailureScreen, {
              locale,
              failure: { reason: "device-not-owned" },
              primaryActionLabel: label,
              onReload: onSwitch,
            }),
      );
      const trigger = screen.getByRole("button", { name: label, exact: true });
      fireEvent.click(trigger);
      expect(onSwitch).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog").textContent).toContain("Your computer will stay signed in");
      const cancel = screen.getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(cancel);
      fireEvent.click(cancel);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(onSwitch).not.toHaveBeenCalled();

      fireEvent.click(trigger);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onSwitch).not.toHaveBeenCalled();

      fireEvent.click(trigger);
      fireEvent.click(
        screen.getByRole("button", {
          name: "Sign out & switch",
        }),
      );
      expect(onSwitch).toHaveBeenCalledOnce();
    },
  );
});

it("retry on a non-account-ownership failure does not open the confirmation", () => {
  const onReload = vi.fn();
  render(
    createElement(WebRemoteControlFailureScreen, {
      locale: "en-US",
      failure: { reason: "desktop-disconnected" },
      onReload,
    }),
  );
  fireEvent.click(screen.getByRole("button"));
  expect(onReload).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});
