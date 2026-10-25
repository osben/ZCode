// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { expectedCopy } from "./helpers/uiCopy.js";

afterEach(cleanup);

// zh-CN/en-US pairs: the locale and the expected close-button name both come from the row,
// so the zh expectation stays as data rather than a locale setup (check-test-copy convention).
it.each([
  ["zh-CN", "关闭"],
  ["en-US", expectedCopy("common.close")],
] as const)("%s dialog close button has a localized name", (locale, close) => {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        Dialog,
        { open: true },
        createElement(
          DialogContent,
          { "aria-describedby": undefined },
          createElement(DialogTitle, null, "Connection"),
        ),
      ),
    ),
  );
  expect(screen.getByRole("button", { name: close })).toBeTruthy();
});

it("status changes are announced in a live region and the navigation dot has semantics and a name", () => {
  const view = (state: "online" | "offline") =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(RemoteConnectionStatusTag, { status: state }),
      createElement(RemoteConnectionNavigationDot, {
        presentation: resolveRemoteConnectionPresentation({ state }),
      }),
    );
  const { rerender } = render(view("online"));
  const online = expectedCopy("remote.status.online");
  expect(screen.getByRole("status").textContent).toContain(online);
  expect(screen.getByRole("img", { name: online })).toBeTruthy();
  rerender(view("offline"));
  const offline = expectedCopy("remote.status.offline");
  expect(screen.getByRole("status").textContent).toContain(offline);
  expect(screen.getByRole("img", { name: offline })).toBeTruthy();
});
