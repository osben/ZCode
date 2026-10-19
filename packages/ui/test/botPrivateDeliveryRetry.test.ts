// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateDeliveryRetry } from "@/BotsDialog/PrivateDeliveryRetry.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";
const mocks = vi.hoisted(() => ({ retryPrivateDelivery: vi.fn() }));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => ({ botsService: mocks }) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const show = () =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(PrivateDeliveryRetry, { botId: "bot", deliveryId: "failed-1" }),
    ),
  );
describe("private delivery retry", () => {
  it("only retries explicitly and hides the action after success", async () => {
    mocks.retryPrivateDelivery.mockResolvedValue(undefined);
    show();
    expect(mocks.retryPrivateDelivery).not.toHaveBeenCalled();
    const retryButton = screen.getByRole("button");
    expect(retryButton.parentElement?.querySelector("p")?.textContent).toBe(
      expectedCopy("bots.privateDelivery.retryHint"),
    );
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(mocks.retryPrivateDelivery).toHaveBeenCalledWith({
      botId: "bot",
      deliveryId: "failed-1",
    });
  });
  it("keeps an actionable failure when retry is rejected", async () => {
    mocks.retryPrivateDelivery.mockRejectedValue(new Error("expired"));
    show();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
  });
});
