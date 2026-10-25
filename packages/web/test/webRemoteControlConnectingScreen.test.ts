import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlLoadingScreen } from "#src/web-remote-control/views.js";

const render = (props: Parameters<typeof WebRemoteControlLoadingScreen>[0]) =>
  renderToStaticMarkup(createElement(WebRemoteControlLoadingScreen, props));

describe("connecting screen", () => {
  it("shows the target computer, its platform icon and the current stage", () => {
    const html = render({
      state: "authenticating",
      locale: "en-US",
      device: { name: "Alice’s MacBook", platform: "darwin" },
    });
    expect(html).toContain("Connecting to Alice’s MacBook");
    expect(html).toContain("Authenticating device…");
    expect(html).toContain('data-device-platform-icon="darwin"');
    expect(html.match(/data-step-state="done"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*data-step-state="active"/);
  });

  it("uses generic copy and the computer icon without a name; reconnecting shows no active step", () => {
    const html = render({ state: "reconnecting", locale: "en-US" });
    expect(html).toContain("Connecting to your computer");
    expect(html).toContain('data-device-platform-icon="unknown"');
    expect(html).toContain("Connection interrupted, reconnecting…");
    expect(html).toContain("Auto-reconnecting after network or wake-up changes.");
    expect(html.match(/data-step-state="idle"/g)).toHaveLength(4);
    expect(html).not.toContain('aria-current="step"');
  });

  it("enters the last segment once pairing completes", () => {
    const html = render({ state: "paired", locale: "en-US", device: { name: "PC" } });
    expect(html).toContain("Paired. Loading workspace…");
    expect(html.match(/data-step-state="done"/g)).toHaveLength(3);
  });
});
