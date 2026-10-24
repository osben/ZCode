// @vitest-environment jsdom
// ISSUE-058: provider rows in the composer model picker are browse-only
// (specs/composer-model-picker-browse-only-providers.md).
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";

const groups: ComposerPlanGroup[] = [
  {
    key: "a",
    label: "Provider A",
    labelBadge: "API",
    items: [
      { key: "flash", value: "a/flash", name: "Flash" },
      { key: "pro", value: "a/pro", name: "Pro" },
    ],
  },
  {
    key: "b",
    label: "Provider B",
    labelBadge: "Local",
    items: [{ key: "local", value: "b/local", name: "Local model" }],
  },
];

const spies = {
  pickInGroup: vi.fn(),
  pickModel: vi.fn(),
  setEffort: vi.fn(),
};

function Harness({ withProviderMenu = true }: { withProviderMenu?: boolean }) {
  const [model, setModel] = useState("a/flash");
  const [effort, setEffort] = useState("disabled");
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(
      TooltipProvider,
      null,
      createElement(ModelConfigSelect, {
        modelGroups: groups,
        normalizedValue: model,
        triggerLabel: model,
        tooltipTitle: model,
        lockReasonMessage: "",
        isItemLocked: () => false,
        onValueChange: (value: string) => {
          spies.pickModel(value);
          setModel(value);
          // Explicit model pick: target default effort (completeNewModelSelection).
          setEffort("max");
        },
        open: true,
        onOpenChange: () => {},
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          effortLabel: "Effort",
          selectModelLabel: "Select model",
          levels: [
            { value: "disabled", label: "Off" },
            { value: "medium", label: "Medium" },
            { value: "max", label: "Max" },
          ],
          value: effort,
          onValueChange: (value: string) => {
            spies.setEffort(value);
            setEffort(value);
          },
          ...(withProviderMenu
            ? {
                providerMenu: {
                  groups,
                  selectedKey: groups.find((g) => g.items.some((i) => i.value === model))?.key,
                  pending: false,
                  error: null,
                  onSelectModel: (group: ComposerPlanGroup, value: string) => {
                    spies.pickInGroup(group.key, value);
                    setModel(value);
                    setEffort("max");
                  },
                },
              }
            : {}),
        },
      }),
    ),
  );
}

function openProviders() {
  fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
}
const providerRow = (name: string) => screen.getByRole("menuitemradio", { name });
const modelRow = (name: string) => screen.getByRole("menuitemradio", { name, exact: true });
const expectNoWrites = () => {
  expect(spies.pickInGroup).not.toHaveBeenCalled();
  expect(spies.pickModel).not.toHaveBeenCalled();
  expect(spies.setEffort).not.toHaveBeenCalled();
};

beforeEach(() => {
  Object.values(spies).forEach((spy) => spy.mockClear());
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);

describe.each([true, false])("browse-only provider rows (providerMenu=%s)", (withProviderMenu) => {
  it("clicking a provider only shows its models and keeps model and effort", async () => {
    render(createElement(Harness, { withProviderMenu }));
    openProviders();
    fireEvent.click(providerRow("Provider B Local"));
    await waitFor(() => expect(modelRow("Local model")).toBeTruthy());
    expectNoWrites();
    expect(screen.getByTestId("chat-model-select-trigger").dataset.modelCurrentValue).toBe(
      "a/flash",
    );
    expect(modelRow("Local model").getAttribute("aria-checked")).toBe("false");
    // A browsed, non-selected provider shows no effort instead of a reset one.
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("—");

    openProviders();
    // The check mark stays on the selected provider, not the browsed one.
    expect(providerRow("Provider A API").getAttribute("aria-checked")).toBe("true");
    expect(providerRow("Provider B Local").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(providerRow("Provider A API"));
    await waitFor(() => expect(modelRow("Flash").getAttribute("aria-checked")).toBe("true"));
    expectNoWrites();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Off");
  });

  it("hovering a provider row writes nothing", () => {
    render(createElement(Harness, { withProviderMenu }));
    openProviders();
    fireEvent.pointerMove(providerRow("Provider B Local"));
    fireEvent.mouseEnter(providerRow("Provider B Local"));
    expectNoWrites();
    expect(modelRow("Flash").getAttribute("aria-checked")).toBe("true");
  });

  it("keyboard Enter on a provider row behaves the same", async () => {
    render(createElement(Harness, { withProviderMenu }));
    openProviders();
    fireEvent.keyDown(providerRow("Provider B Local"), { key: "Enter" });
    await waitFor(() => expect(modelRow("Local model")).toBeTruthy());
    expectNoWrites();
  });

  it("re-picking the selected model keeps effort", () => {
    render(createElement(Harness, { withProviderMenu }));
    fireEvent.click(modelRow("Flash"));
    expectNoWrites();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Off");
  });

  it("picking a model in the selected provider uses the normal model change", () => {
    render(createElement(Harness, { withProviderMenu }));
    fireEvent.click(modelRow("Pro"));
    expect(spies.pickModel).toHaveBeenCalledWith("a/pro");
    expect(spies.pickInGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Max");
  });

  it("picking a model in a browsed provider changes the model", async () => {
    render(createElement(Harness, { withProviderMenu }));
    openProviders();
    fireEvent.click(providerRow("Provider B Local"));
    fireEvent.click(await waitFor(() => modelRow("Local model")));
    if (withProviderMenu) {
      expect(spies.pickInGroup).toHaveBeenCalledWith("b", "b/local");
      expect(spies.pickModel).not.toHaveBeenCalled();
    } else expect(spies.pickModel).toHaveBeenCalledWith("b/local");
    await waitFor(() =>
      expect(screen.getByTestId("chat-model-select-trigger").dataset.modelCurrentValue).toBe(
        "b/local",
      ),
    );
  });

  it("narrow provider page returns to the browsed models without selecting", async () => {
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    render(createElement(Harness, { withProviderMenu }));
    fireEvent.click(screen.getByTestId("composer-provider-trigger"));
    fireEvent.click(providerRow("Provider B Local"));
    await waitFor(() => expect(modelRow("Local model")).toBeTruthy());
    expect(screen.queryByTestId("composer-provider-back")).toBeNull();
    expectNoWrites();
  });
});
