// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { RemoteConnectionStatusTag } from "@/remote-connection/RemoteConnectionTags.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

afterEach(cleanup);

it("对话框关闭按钮有本地化名称", () => {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
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
  expect(screen.getByRole("button", { name: expectedCopy("common.close") })).toBeTruthy();
});

it("状态变化在 live region 中读出，导航状态点有语义和名称", () => {
  const view = (state: "online" | "offline") =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(RemoteConnectionStatusTag, { status: state }),
      createElement(RemoteConnectionNavigationDot, {
        presentation: resolveRemoteConnectionPresentation({ state }),
      }),
    );
  const online = expectedCopy("remote.status.online");
  const offline = expectedCopy("remote.status.offline");
  const { rerender } = render(view("online"));
  expect(screen.getByRole("status").textContent).toContain(online);
  expect(screen.getByRole("img", { name: online })).toBeTruthy();
  rerender(view("offline"));
  expect(screen.getByRole("status").textContent).toContain(offline);
  expect(screen.getByRole("img", { name: offline })).toBeTruthy();
});
