import { describe, expect, it } from "vitest";

import { findQuickPromptGlobalBlockers } from "./contract.js";
import { quickPromptsModule } from "./module.js";

function paragraph(...children: unknown[]): unknown {
  return { type: "paragraph", version: 1, children };
}

function mention(category: string, data?: Record<string, unknown>): unknown {
  return { type: "prompt-mention", category, data, text: category, version: 1 };
}

describe("quick-prompts contract", () => {
  it("declares its module manifest", () => {
    expect(quickPromptsModule.id).toBe("quick-prompts");
  });

  it("allows plain text, commands, plugins and user/plugin skills in a global body", () => {
    const nodes = JSON.stringify([
      paragraph(
        { type: "text", text: "Review ", version: 1 },
        mention("commands"),
        mention("plugins"),
        mention("skills", { scope: "user" }),
        mention("skills", { scope: "plugin" }),
      ),
    ]);
    expect(findQuickPromptGlobalBlockers(nodes)).toEqual([]);
  });

  it("reports project-bound mentions", () => {
    const nodes = JSON.stringify([
      paragraph(mention("files"), mention("skills", { scope: "workspace" })),
      paragraph(mention("sessions"), mention("subagents"), mention("whiteboards")),
    ]);
    expect(findQuickPromptGlobalBlockers(nodes).sort()).toEqual(
      ["file", "session", "subagent", "whiteboard", "workspace-skill"].sort(),
    );
  });

  it("rejects malformed bodies instead of guessing", () => {
    expect(() => findQuickPromptGlobalBlockers("{}")).toThrow();
    expect(() => findQuickPromptGlobalBlockers("not json")).toThrow();
  });
});
