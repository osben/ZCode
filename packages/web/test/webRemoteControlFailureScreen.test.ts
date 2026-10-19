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
    expect(copy.title.trim()).not.toBe("");
    expect(copy.description.trim()).not.toBe("");
    expect(copy.action.trim()).not.toBe("");
    expect(copy.nextSteps).not.toHaveLength(0);
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
    expect(copy.title.trim()).not.toBe("");
    expect(copy.description.trim()).not.toBe("");
    expect(copy.nextSteps).not.toHaveLength(0);
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
    expect(copy.title.trim()).not.toBe("");
    expect(copy.description.trim()).not.toBe("");
    expect(copy.action.trim()).not.toBe("");
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

    expect(html).toContain("<main");
    expect(html).toContain("<h1");
    expect(html).toContain("<ol");
    expect(html).toContain("<button");
    expect(html).toContain("Desktop device is offline.");
  });
});
