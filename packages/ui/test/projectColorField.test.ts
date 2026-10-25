// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectColorField } from "@/project-sidebar/ProjectColorField.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

function renderField(value: "blue" | null, onChange = vi.fn()) {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ProjectColorField, { value, onChange }),
    ),
  );
  return onChange;
}

describe("ProjectColorField", () => {
  it("marks the current color and reports a new selection", () => {
    const onChange = renderField("blue");
    expect(screen.getByLabelText("Blue").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Red"));
    expect(onChange).toHaveBeenCalledWith("red");
  });

  it("clears the color through the no-color swatch", () => {
    const onChange = renderField("blue");
    fireEvent.click(screen.getByLabelText("No color"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
