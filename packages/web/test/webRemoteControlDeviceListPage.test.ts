import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type {
  WebRemoteControlDeviceGroup,
  WebRemoteControlDeviceListView,
} from "#src/web-remote-control/index.js";

import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlConnectionList,
} from "#src/web-remote-control/views.js";

const actions = { onSelect: () => {}, onRefresh: () => {}, onSwitchAccount: () => {} };

const connection = (
  sid: string,
  mid: string,
  meta: WebRemoteControlRelayV2Device["meta"],
  createdAt = 1,
): WebRemoteControlRelayV2Device => ({
  device_sid: sid,
  device_mid: mid,
  online: true,
  created_at: createdAt,
  meta,
});

const mac: WebRemoteControlDeviceGroup = {
  deviceMid: "abcdefgh-long",
  name: "MacBook",
  platform: "darwin",
  onlineConnections: [
    connection("on", "abcdefgh-long", { name: "MacBook", platform: "darwin", version: "3.15.0" }),
  ],
};
const homePc: WebRemoteControlDeviceGroup = {
  deviceMid: "12345678-long",
  name: "Home PC",
  platform: "linux",
  onlineConnections: [],
};
const unnamed: WebRemoteControlDeviceGroup = { deviceMid: "87654321-long", onlineConnections: [] };

function render(
  view: Partial<WebRemoteControlDeviceListView> & Pick<WebRemoteControlDeviceListView, "devices">,
) {
  return renderToStaticMarkup(
    createElement(WebRemoteControlDeviceListPage, {
      ...actions,
      locale: "en-US",
      view: { kind: "devices", loading: false, error: false, ...view },
    }),
  );
}

describe("device list before connecting", () => {
  it("groups by online and offline, shows platform and version, disables offline rows and hides device IDs", () => {
    const html = render({ devices: [mac, homePc, unnamed] });
    expect(html).toContain("Choose a computer");
    expect(html).toMatch(/Online<span[^>]*>1<\/span>/);
    expect(html).toMatch(/Offline<span[^>]*>2<\/span>/);
    expect(html).toContain("macOS · ZCode 3.15.0");
    expect(html).toContain("Linux · Offline");
    expect(html).toContain("Unnamed device");
    expect(html).toContain('data-device-platform-icon="darwin"');
    expect(html).toContain('data-device-platform-icon="linux"');
    expect(html).toContain('data-device-platform-icon="unknown"');
    expect(html).not.toContain("abcdefgh");
    expect(html).not.toContain("12345678");
    // Both offline rows are natively disabled; the single online connection row stays clickable.
    expect(html.match(/<button type="button" disabled=""[^>]*class="flex w-full/g)).toHaveLength(2);
    expect(html).toContain("Don&#x27;t see your computer?");
  });

  it("appends the first 8 MID characters to same-name devices in a group and hides IDs otherwise", () => {
    const twin = { ...homePc, deviceMid: "fedcba98-long", name: "Home PC" };
    const html = render({ devices: [mac, homePc, twin] });
    expect(html).toContain("Linux · Offline · ID 12345678");
    expect(html).toContain("Linux · Offline · ID fedcba98");
    expect(html).not.toContain("abcdefgh");
  });

  it("shows the account display name and login provider; without an account only the switch-account button remains", () => {
    const withAccount = render({
      devices: [mac],
      account: { displayName: "jyrong", provider: "bigmodel" },
    });
    expect(withAccount).toContain("jyrong · BigModel");
    expect(withAccount).toMatch(/>J<\/span>/);
    expect(withAccount).toContain(">Switch</button>");
    const withoutAccount = render({ devices: [mac] });
    expect(withoutAccount).toContain(">Switch account</button>");
    expect(withoutAccount).not.toContain(" · Z.ai");
  });

  it("shows several online connections as one row with the connection count and an expandable list", () => {
    const multi: WebRemoteControlDeviceGroup = {
      deviceMid: "abcdefgh-long",
      name: "Workstation",
      platform: "win32",
      onlineConnections: ["sid-one", "sid-two"].map((sid) =>
        connection(sid, "abcdefgh-long", { name: "Workstation", version: "3.14.1" }),
      ),
    };
    const html = render({ devices: [multi] });
    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain("2 connections");
    expect(html).toContain(">Windows</span>");
    expect(html).not.toContain("sid-one");
    expect(html).not.toContain('disabled=""');
  });

  it("the connection picker shows version, start time and the last 6 SID characters, never the full SID, and disables while refreshing", () => {
    const now = Date.UTC(2026, 8, 23, 12);
    const device: WebRemoteControlDeviceGroup = {
      deviceMid: "abcdefgh-long",
      name: "Workstation",
      platform: "win32",
      onlineConnections: [
        connection(
          "sid-alpha-a41f9c",
          "abcdefgh-long",
          { version: "3.15.0" },
          now / 1000 - 3 * 3600,
        ),
        connection(
          "e2e-device-alternative-with-a-long-connection-identifier",
          "abcdefgh-long",
          {},
          now / 1000 - 2 * 86_400,
        ),
      ],
    };
    const list = (disabled = false) =>
      renderToStaticMarkup(
        createElement(WebRemoteControlConnectionList, {
          device,
          locale: "en-US",
          disabled,
          now,
          onSelect: () => {},
        }),
      );
    const html = list();
    expect(html).toContain("ZCode 3.15.0");
    expect(html).toContain("started 3 hours ago · ID a41f9c");
    expect(html).toContain(">ZCode</span>");
    expect(html).toContain("started 2 days ago · ID tifier");
    expect(html).not.toContain("e2e-device-alternative");
    expect(list(true).match(/disabled=""/g)).toHaveLength(2);
  });

  it("an empty list explains how to enable remote control and offers refresh; loading and failure never look empty", () => {
    const empty = (loading: boolean, error: boolean) => render({ devices: [], loading, error });
    expect(empty(false, false)).toContain("No devices yet");
    expect(empty(false, false)).toContain(
      "Sign in with the same account on your computer, enable Web remote control, then refresh this list.",
    );
    expect(empty(false, false)).toContain(">Refresh</button>");
    expect(empty(true, false)).toContain("Loading devices…");
    expect(empty(true, false)).not.toContain("No devices yet");
    expect(empty(true, false)).toMatch(
      /aria-label="Refresh"[^>]*disabled=""|disabled=""[^>]*aria-label="Refresh"/,
    );
    expect(empty(false, true)).toContain("Could not load devices.");
    expect(empty(false, true)).not.toContain("No devices yet");
  });

  it("online rows are not selectable while refreshing or after a refresh failure", () => {
    expect(render({ devices: [mac], loading: true }).match(/disabled=""/g)).toHaveLength(2);
    expect(render({ devices: [mac], error: true }).match(/disabled=""/g)).toHaveLength(1);
  });
});
