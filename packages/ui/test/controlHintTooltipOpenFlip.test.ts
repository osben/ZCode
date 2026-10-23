// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlHintTooltip } from "@/ControlHintTooltip.js";

// Radix Tooltip reports a controlled/uncontrolled switch through console.warn. Callers suppress the hint while a menu is
// open with `open={menuOpen ? false : undefined}`, so every menu open/close used to flip the Tooltip's mode.
const MODE_SWITCH_WARNING =
  /is changing from (controlled|uncontrolled) to (controlled|uncontrolled)/;

function hint(open: boolean | undefined, children: ReactNode = "trigger") {
  return createElement(
    ControlHintTooltip,
    { title: "Mode", standalone: true, open },
    createElement("button", { type: "button" }, children),
  );
}

function modeSwitchWarnings(spies: Array<ReturnType<typeof vi.spyOn>>): string[] {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args: unknown[]) => args.map(String).join(" "))
    .filter((message) => MODE_SWITCH_WARNING.test(message));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ControlHintTooltip open flip", () => {
  it("does not switch Radix between controlled and uncontrolled when a menu suppresses the hint", () => {
    const spies = [
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];

    // Menu closed (uncontrolled), menu opened (suppressed), menu closed again.
    const { rerender } = render(hint(undefined));
    rerender(hint(false));
    rerender(hint(undefined));
    rerender(hint(false));
    rerender(hint(undefined));

    expect(modeSwitchWarnings(spies)).toEqual([]);
  });
});
