// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore, type ConfirmDialogChoice } from "@/store/confirmDialogStore.js";

// jsdom does not turn Enter on a focused button into a click; a browser does unless the keydown was
// cancelled. Mirror that so the test exercises the same routing a real keyboard user hits.
function pressEnter(target: Element) {
  const notCancelled = fireEvent.keyDown(target, { key: "Enter" });
  if (notCancelled && target instanceof HTMLButtonElement) {
    fireEvent.click(target);
  }
}

function openDialog() {
  render(
    createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(ConfirmDialogHost)),
  );
  const choices: ConfirmDialogChoice[] = [];
  act(() => {
    void useConfirmDialogStore
      .getState()
      .requestChoice({
        title: "Delete server?",
        confirmLabel: "Delete",
        cancelLabel: "Keep",
        confirmVariant: "destructive",
        showCloseButton: true,
      })
      .then((choice) => choices.push(choice));
  });
  return choices;
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ConfirmDialogHost Enter routing", () => {
  afterEach(() => {
    cleanup();
    useConfirmDialogStore.setState({ pendingRequest: undefined });
  });

  it("cancels when Enter is pressed on the focused Cancel button", async () => {
    const choices = openDialog();
    const cancel = screen.getByRole("button", { name: /Keep/ });
    act(() => cancel.focus());

    pressEnter(cancel);
    await flushPromises();

    expect(choices).toEqual(["cancel"]);
  });

  it("dismisses when Enter is pressed on the focused Close button", async () => {
    const choices = openDialog();
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => !button.textContent?.includes("Keep"))!;
    act(() => close.focus());

    pressEnter(close);
    await flushPromises();

    expect(choices).toEqual(["dismiss"]);
  });

  it("confirms exactly once when Enter is pressed on the focused Confirm button", async () => {
    const choices = openDialog();
    const confirm = screen.getByRole("button", { name: /Delete/ });
    act(() => confirm.focus());

    pressEnter(confirm);
    await flushPromises();

    expect(choices).toEqual(["confirm"]);
  });

  it("still confirms on Enter when focus is on non-interactive dialog content", async () => {
    const choices = openDialog();
    const title = screen.getByText("Delete server?");

    pressEnter(title);
    await flushPromises();

    expect(choices).toEqual(["confirm"]);
  });
});
