// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelReasoningLevelEditor } from "@/settings/model-provider-section/ProviderModelReasoningLevelEditor.js";
import { expectedCopy } from "./helpers/uiCopy.js";

afterEach(cleanup);

describe("ProviderModelReasoningLevelEditor", () => {
  it("does not create a personal override when a level is only focused then blurred", () => {
    const onChange = vi.fn();
    render(
      createElement(ProviderModelReasoningLevelEditor, {
        values: ["low", "high"],
        overridden: false,
        addLabel: expectedCopy("settings.modelProvider.reasoningLevelAdd"),
        deleteLabel: expectedCopy("settings.modelProvider.reasoningLevelDelete"),
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "low" }));
    fireEvent.blur(screen.getByDisplayValue("low"));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("completes keyboard reordering, editing, adding and deleting", () => {
    function Harness() {
      const [values, setValues] = useState<readonly string[]>(["low", "high"]);
      return createElement(ProviderModelReasoningLevelEditor, {
        values,
        overridden: true,
        addLabel: expectedCopy("settings.modelProvider.reasoningLevelAdd"),
        deleteLabel: expectedCopy("settings.modelProvider.reasoningLevelDelete"),
        onChange: setValues,
      });
    }

    const { container } = render(createElement(Harness));

    const readValues = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-model-reasoning-level-editor="true"] > div > button:first-of-type',
        ),
      ).map((button) => button.textContent);

    fireEvent.keyDown(screen.getByRole("button", { name: "low" }), {
      altKey: true,
      key: "ArrowRight",
    });
    expect(readValues()).toEqual(["high", "low"]);

    const chips = container.querySelectorAll<HTMLElement>(
      '[data-model-reasoning-level-editor="true"] > div',
    );
    fireEvent.dragStart(chips[0]!, {
      dataTransfer: { effectAllowed: "none" },
    });
    fireEvent.drop(chips[1]!);
    expect(readValues()).toEqual(["low", "high"]);

    fireEvent.click(screen.getByRole("button", { name: "high" }));
    fireEvent.change(screen.getByDisplayValue("high"), { target: { value: "medium" } });
    fireEvent.keyDown(screen.getByDisplayValue("medium"), { key: "Enter" });
    expect(readValues()).toEqual(["low", "medium"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: expectedCopy("settings.modelProvider.reasoningLevelAdd"),
      }),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "max" } });
    fireEvent.keyDown(screen.getByDisplayValue("max"), { key: "Enter" });
    expect(readValues()).toEqual(["low", "medium", "max"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: `${expectedCopy("settings.modelProvider.reasoningLevelDelete")}: low`,
      }),
    );
    expect(readValues()).toEqual(["medium", "max"]);
    expect(container.querySelector('[data-personal-override="true"]')).toBeTruthy();
  });
});
