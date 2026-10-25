// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy, TEST_LOCALE } from "./helpers/uiCopy.js";

afterEach(cleanup);

function renderIndicator(sweepActive = false, animateEntrance = true) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: TEST_LOCALE },
      createElement(
        TooltipProvider,
        null,
        createElement(HighspeedModelIndicator, {
          model: "GLM-5.3",
          originalModel: "GLM-5.2",
          sweepActive,
          animateEntrance,
        }),
      ),
    ),
  );
}

/** The flip animation lives on the motion container wrapping the icon and text. */
function readFlipContainerOpacity(container: HTMLElement): string | undefined {
  const flip = container.querySelector('[data-highspeed-model-icon="true"]')?.parentElement;
  return flip?.style.opacity;
}

describe("HighspeedModelIndicator", () => {
  it("renders the draw model as a read-only Highspeed identity", () => {
    const { container, getByLabelText } = renderIndicator();
    expect(getByLabelText("GLM-5.3 HighSpeed")).toBeTruthy();
    expect(container.textContent).toContain("GLM-5.3 HighSpeed");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-chat-toolbar-popover-trigger="true"]')).toBeNull();
  });

  it("shows the pre-acceleration original model on hover", async () => {
    renderIndicator();

    fireEvent.pointerMove(screen.getByLabelText("GLM-5.3 HighSpeed"), {
      pointerType: "mouse",
    });

    expect(
      (
        await screen.findAllByText(
          expectedCopy("chat.highspeed.originalModel", { model: "GLM-5.2" }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Time remaining/)).toBeNull();
  });

  it("a fresh draw hit enters from the flip start point; switching back or restoring shows the resting indicator directly", () => {
    const activation = renderIndicator(false, true);
    expect(readFlipContainerOpacity(activation.container)).toBe("0");
    activation.unmount();

    const restore = renderIndicator(false, false);
    expect(readFlipContainerOpacity(restore.container)).toBe("1");
  });
});
