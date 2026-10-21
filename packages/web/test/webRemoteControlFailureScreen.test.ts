import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlFailureScreen } from "#src/web-remote-control/views.js";

describe("WebRemoteControlFailureScreen", () => {
  it("renders structured recovery guidance and the relay detail message", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlFailureScreen, {
        failure: {
          reason: "desktop-disconnected",
          message: "Desktop device is offline.",
        },
        locale: "en-US",
        onReload: () => {},
      }),
    );

    expect(html).toContain("Desktop Offline");
    expect(html).toContain("What happened");
    expect(html).toContain("Desktop device is offline.");
    expect(html).toContain("Try Again");
  });
  it("device-not-owned failure offers switch-account and choose-another-device actions", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlFailureScreen, {
        failure: { reason: "device-not-owned" },
        locale: "en-US",
        onReload: () => {},
        primaryActionLabel: "Switch account",
        secondaryAction: { label: "Choose another device", onClick: () => {} },
      }),
    );
    expect(html).toContain("This device does not belong to this account");
    expect(html).toContain("Switch account");
    expect(html).toContain("Choose another device");
    expect(html).not.toContain(">Try Again</button>");
  });
});
