// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreComposerInputFocusAfterPickerClose } from "@/lib/pickerFocus.js";

function mountComposer(id: string): {
  root: HTMLElement;
  input: HTMLElement;
  trigger: HTMLElement;
} {
  const root = document.createElement("div");
  root.setAttribute("data-testid", "v4-composer");
  const input = document.createElement("textarea");
  input.setAttribute("data-testid", "v4-composer-input");
  const trigger = document.createElement("button");
  trigger.setAttribute("data-testid", `${id}-picker-trigger`);
  root.append(input, trigger);
  document.body.append(root);
  return { root, input, trigger };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("restoreComposerInputFocusAfterPickerClose", () => {
  it("keeps focus in the composer that owns the picker, not the first composer in the document", () => {
    // Regression: side conversations (and split panes) mount a second composer after the main one;
    // a global querySelector always matched the main input and stole focus from the side conversation.
    const main = mountComposer("main");
    const side = mountComposer("side");

    restoreComposerInputFocusAfterPickerClose({ anchor: side.trigger });

    expect(document.activeElement).toBe(side.input);
    expect(document.activeElement).not.toBe(main.input);
  });

  it("falls back to the caller-provided global selector when the trigger is outside any composer root", () => {
    const main = mountComposer("main");
    const orphanTrigger = document.createElement("button");
    document.body.append(orphanTrigger);

    restoreComposerInputFocusAfterPickerClose({
      anchor: orphanTrigger,
      fallbackSelector: '[data-testid="v4-composer-input"]',
    });

    expect(document.activeElement).toBe(main.input);
  });

  it("does not move focus when no scoped input and no fallback selector resolve", () => {
    const orphanTrigger = document.createElement("button");
    document.body.append(orphanTrigger);

    restoreComposerInputFocusAfterPickerClose({ anchor: orphanTrigger, fallbackSelector: null });

    expect(document.activeElement).toBe(document.body);
  });

  it("skips the restore on coarse-touch devices so the on-screen keyboard stays closed", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const side = mountComposer("side");

    restoreComposerInputFocusAfterPickerClose({ anchor: side.trigger });

    expect(document.activeElement).not.toBe(side.input);
    expect(document.activeElement).toBe(document.body);
  });
});
