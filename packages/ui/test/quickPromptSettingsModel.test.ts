import { describe, expect, it } from "vitest";
import {
  buildQuickPromptProjectOptions,
  isLegacySingleRootProjectId,
  moveQuickPromptId,
  quickPromptErrorMessageId,
  quickPromptPreviewText,
} from "@/quick-prompts/model.js";

const LOCAL = "local-host";
const REMOTE = "remote-host";

describe("buildQuickPromptProjectOptions (Settings project picker)", () => {
  it("offers tree projects in tree order and appends unavailable projects that only own quick prompts", () => {
    const options = buildQuickPromptProjectOptions({
      projects: [
        { id: "p-alpha", hostId: LOCAL, name: "Alpha" },
        { id: "p-beta", hostId: REMOTE, name: "Beta" },
      ],
      refs: [
        { hostId: LOCAL, projectId: "p-alpha" },
        { hostId: LOCAL, projectId: "p-gone" },
      ],
    });

    expect(
      options.map((option) => [option.project.projectId, option.name, option.available]),
    ).toEqual([
      ["p-alpha", "Alpha", true],
      ["p-beta", "Beta", true],
      ["p-gone", null, false],
    ]);
  });

  it("never offers legacy single-root projects, neither from the tree nor from quick prompt refs", () => {
    const options = buildQuickPromptProjectOptions({
      projects: [
        { id: "p-alpha", hostId: LOCAL, name: "Alpha" },
        { id: "legacy-single-root:/work/old", hostId: LOCAL, name: "Old", legacySingleRoot: true },
        { id: "p-flagged", hostId: LOCAL, name: "Flagged", legacySingleRoot: true },
      ],
      refs: [{ hostId: LOCAL, projectId: "legacy-single-root:/work/other" }],
    });

    expect(options.map((option) => option.project.projectId)).toEqual(["p-alpha"]);
  });

  it("skips deleted tree projects and de-duplicates refs by the (hostId, projectId) pair", () => {
    const options = buildQuickPromptProjectOptions({
      projects: [
        { id: "p-deleted", hostId: LOCAL, name: "Deleted", deleted: true },
        { id: "p-alpha", hostId: LOCAL, name: "Alpha" },
      ],
      refs: [
        { hostId: REMOTE, projectId: "p-alpha" },
        { hostId: REMOTE, projectId: "p-alpha" },
        { hostId: LOCAL, projectId: "p-deleted" },
      ],
    });

    // The same id on another host is a different project; the deleted tree entry becomes unavailable.
    expect(options.map((option) => [option.project.hostId, option.project.projectId])).toEqual([
      [LOCAL, "p-alpha"],
      [REMOTE, "p-alpha"],
      [LOCAL, "p-deleted"],
    ]);
  });
});

describe("isLegacySingleRootProjectId", () => {
  it("recognises the legacy single-root id prefix only", () => {
    expect(isLegacySingleRootProjectId("legacy-single-root:/work/a")).toBe(true);
    expect(isLegacySingleRootProjectId("project-legacy-single-root:x")).toBe(false);
  });
});

describe("quickPromptPreviewText", () => {
  it("collapses whitespace and shows mention links by their label", () => {
    expect(quickPromptPreviewText("review\n\n  the [@src/app.ts](src/app.ts)   diff")).toBe(
      "review the @src/app.ts diff",
    );
  });
});

describe("moveQuickPromptId", () => {
  it("moves the active id to the position of the over id", () => {
    expect(moveQuickPromptId(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveQuickPromptId(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns an unchanged copy for unknown or identical ids", () => {
    const ids = ["a", "b"];
    expect(moveQuickPromptId(ids, "a", "a")).toEqual(["a", "b"]);
    expect(moveQuickPromptId(ids, "x", "a")).toEqual(["a", "b"]);
    expect(moveQuickPromptId(ids, "a", "x")).toEqual(["a", "b"]);
    expect(moveQuickPromptId(ids, "a", "a")).not.toBe(ids);
  });
});

describe("quickPromptErrorMessageId", () => {
  it.each([
    ["quick-prompt.name-required", "quickPrompts.errors.nameInvalid"],
    ["quick-prompt.name-too-long", "quickPrompts.errors.nameInvalid"],
    ["quick-prompt.body-too-long", "quickPrompts.errors.bodyTooLong"],
    ["quick-prompt.global-mention-blocked", "quickPrompts.scope.globalBlocked"],
    ["quick-prompt.limit-reached", "quickPrompts.limit.reached"],
    ["quick-prompt.not-found", "quickPrompts.errors.notFound"],
    ["quick-prompt.reorder-mismatch", "quickPrompts.errors.reorder"],
    ["quick-prompt.read-only", "quickPrompts.errors.readOnly"],
  ])("maps %s to a localized message", (code, messageId) => {
    expect(quickPromptErrorMessageId(new Error(code))).toBe(messageId);
  });

  it("finds a code embedded in a longer RPC error message", () => {
    expect(quickPromptErrorMessageId(new Error("Remote failed: quick-prompt.limit-reached"))).toBe(
      "quickPrompts.limit.reached",
    );
  });

  it("falls back to the generic action message for unknown errors and never returns the raw code", () => {
    const messageId = quickPromptErrorMessageId(new Error("quick-prompt.something-new"));
    expect(messageId).toBe("quickPrompts.errors.action");
    expect(quickPromptErrorMessageId("plain text")).toBe("quickPrompts.errors.action");
    expect(quickPromptErrorMessageId(new Error("x"), "quickPrompts.errors.save")).toBe(
      "quickPrompts.errors.save",
    );
  });
});
