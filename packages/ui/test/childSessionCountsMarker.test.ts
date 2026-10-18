import { describe, expect, it } from "vitest";
import {
  readChildSessionExpansionState,
  persistChildSessionsExpanded,
} from "../src/lib/childSessionExpansionPreference.js";

describe("child session expansion preference", () => {
  it("stores only explicitly expanded parents; default collapsed", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    expect(readChildSessionExpansionState(storage)).toEqual({});
    persistChildSessionsExpanded("s-parent", true, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({ "s-parent": true });
    persistChildSessionsExpanded("s-other", true, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({
      "s-parent": true,
      "s-other": true,
    });
    persistChildSessionsExpanded("s-parent", false, storage);
    expect(readChildSessionExpansionState(storage)).toEqual({ "s-other": true });
  });

  it("tolerates corrupt stored payloads", () => {
    const backing = new Map<string, string>([["zcode-child-session-expansion", "not-json"]]);
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
    expect(readChildSessionExpansionState(storage)).toEqual({});
  });

  it("does not break the expansion toggle when storage writes fail", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is unavailable");
      },
    };
    expect(() => persistChildSessionsExpanded("s-parent", true, storage)).not.toThrow();
  });
});
