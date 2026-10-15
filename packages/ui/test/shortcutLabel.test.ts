import { describe, expect, it } from "vitest";
import { formatShortcutBindingLabel, formatShortcutBindingLabelParts } from "@/shortcuts/label.js";

const APPLE = { platform: "MacIntel", userAgent: "" };
const WINDOWS = { platform: "Win32", userAgent: "" };

describe("formatShortcutBindingLabel", () => {
  it("renders arrow keys as glyphs on both platforms", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+ArrowUp", APPLE)).toBe("⌘ ↑");
    expect(formatShortcutBindingLabel("CmdOrCtrl+ArrowUp", WINDOWS)).toBe("Ctrl+↑");
    expect(formatShortcutBindingLabelParts("Alt+ArrowLeft", APPLE)).toEqual(["⌥", "←"]);
  });

  it("keeps letter, symbol, and other named key legends unchanged", () => {
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Shift+p", APPLE)).toEqual(["⇧", "⌘", "P"]);
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+=", APPLE)).toEqual(["⌘", "+"]);
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Home", WINDOWS)).toEqual(["Ctrl", "Home"]);
  });

  it("passes an unparseable binding through as a single token", () => {
    expect(formatShortcutBindingLabelParts("not a binding", APPLE)).toEqual(["not a binding"]);
  });
});
