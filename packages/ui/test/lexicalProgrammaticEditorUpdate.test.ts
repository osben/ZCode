// @vitest-environment jsdom
// Programmatic-update classification for the composer's text-change flag (ISSUE-037): clears,
// restores and prompt-history recall are app writes, so they must not read as typing.
import { describe, expect, it } from "vitest";
import { isProgrammaticEditorUpdate } from "@/LexicalChatInput.js";
import { shouldSlashPanelProcessUpdate } from "@/lib/slashPanelUpdateFilter.js";
import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";

describe("isProgrammaticEditorUpdate", () => {
  it("treats an untagged update as typing", () => {
    expect(isProgrammaticEditorUpdate(new Set())).toBe(false);
  });

  it("treats the generic programmatic tag as an app write", () => {
    expect(isProgrammaticEditorUpdate(new Set([PROGRAMMATIC_UPDATE_TAG]))).toBe(true);
  });

  it("treats prompt-history recall as an app write", () => {
    expect(isProgrammaticEditorUpdate(new Set([HISTORY_NAVIGATION_UPDATE_TAG]))).toBe(true);
  });

  it("leaves the slash panel filter reading the history tag unchanged", () => {
    expect(shouldSlashPanelProcessUpdate(new Set([HISTORY_NAVIGATION_UPDATE_TAG]))).toBe(false);
    expect(shouldSlashPanelProcessUpdate(new Set([PROGRAMMATIC_UPDATE_TAG]))).toBe(true);
  });
});
