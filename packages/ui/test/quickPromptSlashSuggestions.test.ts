import { describe, expect, it } from "vitest";
import { filterPromptInputSuggestions } from "@/lib/promptInputTriggers.js";
import {
  QUICK_PROMPT_SUGGESTION_ID_PREFIX,
  buildQuickPromptSuggestions,
  isQuickPromptSuggestion,
  type QuickPromptSlashItem,
} from "@/slashCommandHelpers.js";

const items: QuickPromptSlashItem[] = [
  {
    promptId: "p1",
    name: "run e2e",
    text: "Run the desktop e2e\nsuite and report failures",
    nodes: "[]",
  },
  { promptId: "p2", name: "review diff", text: "Review the staged diff for bugs", nodes: "[]" },
];

describe("quick prompt slash suggestions (rule 4)", () => {
  it("builds prefixed ids so they never collide with commands, skills or subagents", () => {
    const suggestions = buildQuickPromptSuggestions(items);
    expect(suggestions.map((item) => item.id)).toEqual([
      `${QUICK_PROMPT_SUGGESTION_ID_PREFIX}p1`,
      `${QUICK_PROMPT_SUGGESTION_ID_PREFIX}p2`,
    ]);
    expect(suggestions.every(isQuickPromptSuggestion)).toBe(true);
    expect(isQuickPromptSuggestion({ ...suggestions[0]!, id: "app-slash:side" })).toBe(false);
  });

  it("matches by name and by text, and the description is a single-line preview", () => {
    const suggestions = buildQuickPromptSuggestions(items);
    expect(filterPromptInputSuggestions(suggestions, "e2e").map((item) => item.label)).toEqual([
      "run e2e",
    ]);
    expect(
      filterPromptInputSuggestions(suggestions, "staged diff").map((item) => item.label),
    ).toEqual(["review diff"]);
    expect(suggestions[0]?.description).toBe("Run the desktop e2e suite and report failures");
  });

  it("keeps the stored name as the value so the typed token range can be replaced", () => {
    const [first] = buildQuickPromptSuggestions(items);
    expect(first?.value).toBe("run e2e");
    expect(first?.trigger).toBe("/");
  });
});
