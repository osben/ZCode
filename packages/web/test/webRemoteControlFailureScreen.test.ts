import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenCopy,
} from "../src/webRemoteControlFailureScreen.js";

describe("WebRemoteControlFailureScreen", () => {
  it("explains DEVICE_OFFLINE as a desktop disconnected state", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      { reason: "desktop-disconnected", message: "Desktop device is offline." },
      "en-US",
    );

    expect(copy.tone).toBe("danger");
    expect(copy.title).toBe("Desktop Offline");
    expect(copy.description).toContain("The desktop side disconnected.");
    expect(copy.action).toBe("Try Again");
  });

  it("explains mobile recovery timeout without blaming desktop offline", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      {
        reason: "connection-recovery-timeout",
        message: "Mobile connection did not recover the RPC bridge in time.",
      },
      "en-US",
    );

    expect(copy.tone).toBe("warning");
    expect(copy.title).toBe("Connection Recovery Timed Out");
    expect(copy.description).toContain("did not recover its remote control connection in time");
    expect(copy.description).not.toContain("The desktop side disconnected.");
  });

  it("explains KICKED as another mobile controller taking over", () => {
    const copy = resolveWebRemoteControlScreenCopy(
      {
        reason: "session-conflict",
        message: "Another mobile controller replaced this one.",
      },
      "en-US",
    );

    expect(copy.tone).toBe("warning");
    expect(copy.title).toBe("Taken Over By Another Device");
    expect(copy.description).toContain("Another remote control device connected");
  });

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
});
