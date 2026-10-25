// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { VoiceDictationLanguagePicker } from "@/settings/VoiceDictationLanguagePicker.js";
import {
  TID_VOICE_LANGUAGE_CLEAR,
  TID_VOICE_LANGUAGE_EMPTY,
  TID_VOICE_LANGUAGE_OPTION,
  TID_VOICE_LANGUAGE_SEARCH,
  TID_VOICE_LANGUAGE_TRIGGER,
  testId,
} from "@zcode/shared";
import { expectedCopy } from "./helpers/uiCopy.js";

afterEach(cleanup);

const OPTIONS = [
  { code: "de", label: "German" },
  { code: "en", label: "English" },
  { code: "uk", label: "Ukrainian" },
  { code: "ru", label: "Russian" },
];

function renderPicker(selected: string[], handlers = { onToggle: vi.fn(), onClear: vi.fn() }) {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(VoiceDictationLanguagePicker, {
        selected,
        options: OPTIONS,
        ...handlers,
        ariaLabel: "Languages",
      }),
    ),
  );
  return handlers;
}

const trigger = () => screen.getByTestId(TID_VOICE_LANGUAGE_TRIGGER);

describe("VoiceDictationLanguagePicker", () => {
  it("summarises the selection on the trigger", () => {
    renderPicker([]);
    expect(trigger().textContent).toContain(expectedCopy("voiceDictation.language.auto"));
    cleanup();
    renderPicker(["uk", "en"]);
    expect(trigger().textContent).toContain("Ukrainian, English");
    cleanup();
    renderPicker(["uk", "en", "de"]);
    expect(trigger().textContent).toContain("3 languages");
  });

  it("reports which language was toggled and leaves applying it to the owner", () => {
    const { onToggle } = renderPicker(["uk"]);
    fireEvent.click(trigger());

    fireEvent.click(screen.getByTestId(testId(TID_VOICE_LANGUAGE_OPTION, "en")));
    expect(onToggle).toHaveBeenLastCalledWith("en");

    fireEvent.click(screen.getByTestId(testId(TID_VOICE_LANGUAGE_OPTION, "uk")));
    expect(onToggle).toHaveBeenLastCalledWith("uk");
  });

  it("lists selected languages first and filters by name or code", () => {
    renderPicker(["ru"]);
    fireEvent.click(trigger());

    const labels = () => screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
    expect(labels()).toEqual(["Russian", "German", "English", "Ukrainian"]);

    fireEvent.change(screen.getByTestId(TID_VOICE_LANGUAGE_SEARCH), { target: { value: "uk" } });
    expect(labels()).toEqual(["Ukrainian"]);

    fireEvent.change(screen.getByTestId(TID_VOICE_LANGUAGE_SEARCH), {
      target: { value: "zzz" },
    });
    expect(screen.getByTestId(TID_VOICE_LANGUAGE_EMPTY).textContent).toBe(
      expectedCopy("voiceDictation.language.noMatch"),
    );
  });

  it("clears the selection back to auto-detect", () => {
    const { onClear } = renderPicker(["uk", "en"]);
    fireEvent.click(trigger());
    fireEvent.click(within(document.body).getByTestId(TID_VOICE_LANGUAGE_CLEAR));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
