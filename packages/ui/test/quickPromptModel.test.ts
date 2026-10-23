import { describe, expect, it } from "vitest";
import {
  findQuickPromptGlobalBlockers,
  type QuickPrompt,
  type QuickPromptSnapshot,
} from "@zcode/services";
import {
  composeQuickPromptRow,
  composeQuickPromptSlashItems,
  defaultQuickPromptScope,
  isQuickPromptFirstRun,
  isQuickPromptBodyPresent,
  isValidQuickPromptName,
  prefillQuickPromptName,
  quickPromptErrorMessageId,
  quickPromptBlockMessageId,
  quickPromptProjectRefOf,
  quickPromptScopeBlocks,
  resolveQuickPromptChipAction,
  toPortableGlobalBody,
} from "@/quick-prompts/model.js";

const project = { hostId: "host-a", projectId: "proj:1" };

function prompt(
  id: string,
  scope: "global" | "project",
  overrides: Partial<QuickPrompt> = {},
): QuickPrompt {
  return {
    promptId: id,
    scope,
    project: scope === "project" ? project : null,
    name: `name-${id}`,
    body: { markdown: `text ${id}`, nodes: "[]" },
    pinned: true,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function snapshot(input: {
  globals?: Array<QuickPrompt & { hiddenInProject?: boolean }>;
  projectPrompts?: QuickPrompt[];
}): QuickPromptSnapshot {
  return {
    project,
    globals: (input.globals ?? []).map((item) => ({
      ...item,
      hiddenInProject: item.hiddenInProject ?? false,
    })),
    projectPrompts: input.projectPrompts ?? [],
  };
}

describe("quick prompt row composition (rules 2, 6)", () => {
  it("shows pinned globals not hidden in the project first, then the pinned project prompts", () => {
    const row = composeQuickPromptRow(
      snapshot({
        globals: [
          prompt("g1", "global"),
          prompt("g2", "global", { pinned: false }),
          prompt("g3", "global", { hiddenInProject: true }),
          prompt("g4", "global"),
        ],
        projectPrompts: [prompt("p1", "project"), prompt("p2", "project", { pinned: false })],
      }),
    );
    expect(row.map((item) => item.promptId)).toEqual(["g1", "g4", "p1"]);
  });

  it("returns nothing without a snapshot", () => {
    expect(composeQuickPromptRow(null)).toEqual([]);
  });

  it("treats a project without any quick prompt as first run, but not a project with unpinned ones", () => {
    expect(isQuickPromptFirstRun(snapshot({}))).toBe(true);
    expect(
      isQuickPromptFirstRun(
        snapshot({ projectPrompts: [prompt("p", "project", { pinned: false })] }),
      ),
    ).toBe(false);
    expect(isQuickPromptFirstRun(null)).toBe(false);
  });
});

describe("quick prompt slash items (rule 4)", () => {
  it("lists every available quick prompt, pinned or not, and drops globals hidden in the project", () => {
    const items = composeQuickPromptSlashItems(
      snapshot({
        globals: [
          prompt("g1", "global", { pinned: false }),
          prompt("g2", "global", { hiddenInProject: true }),
        ],
        projectPrompts: [prompt("p1", "project", { pinned: false })],
      }),
    );
    expect(items.map((item) => item.promptId)).toEqual(["g1", "p1"]);
    expect(items[0]).toMatchObject({ name: "name-g1", text: "text g1", nodes: "[]" });
  });
});

describe("scope rules (defaults, blocks, limits)", () => {
  it("defaults to project inside a project and global without one (rule 13)", () => {
    expect(defaultQuickPromptScope(project)).toBe("project");
    expect(defaultQuickPromptScope(null)).toBe("global");
  });

  it("blocks Global while the body carries a project-bound mention (rule 12, scenario 5)", () => {
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        children: [{ type: "prompt-mention", category: "files", value: "src/a.ts" }],
      },
    ]);
    expect(
      quickPromptScopeBlocks({
        scope: "global",
        project,
        bodyNodes: nodes,
        snapshot: snapshot({}),
      }),
    ).toEqual(["global-mention"]);
    expect(
      quickPromptScopeBlocks({
        scope: "project",
        project,
        bodyNodes: nodes,
        snapshot: snapshot({}),
      }),
    ).toEqual([]);
  });

  it("allows Global for user skills and slash commands", () => {
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        children: [
          { type: "prompt-mention", category: "skills", data: { scope: "user" } },
          { type: "prompt-mention", category: "commands" },
        ],
      },
    ]);
    expect(
      quickPromptScopeBlocks({
        scope: "global",
        project: null,
        bodyNodes: nodes,
        snapshot: snapshot({}),
      }),
    ).toEqual([]);
  });

  it("explains a project-only scope when the session has no project", () => {
    expect(
      quickPromptScopeBlocks({
        scope: "project",
        project: null,
        bodyNodes: null,
        snapshot: snapshot({}),
      }),
    ).toEqual(["no-project"]);
    expect(quickPromptBlockMessageId("no-project")).toBe("quickPrompts.scope.noProject");
    expect(quickPromptBlockMessageId("global-mention")).toBe("quickPrompts.scope.globalBlocked");
  });

  it("reports the 50-per-list limit (rule 18, scenario 11)", () => {
    const fullGlobals = Array.from({ length: 50 }, (_, index) => prompt(`g${index}`, "global"));
    expect(
      quickPromptScopeBlocks({
        scope: "global",
        project,
        bodyNodes: null,
        snapshot: snapshot({ globals: fullGlobals }),
      }),
    ).toEqual(["limit"]);
    expect(
      quickPromptScopeBlocks({
        scope: "global",
        project,
        bodyNodes: null,
        snapshot: snapshot({ globals: fullGlobals.slice(0, 49) }),
      }),
    ).toEqual([]);
  });
});

describe("names and chip actions", () => {
  it("prefills names from the first words and shows mention links by label", () => {
    expect(prefillQuickPromptName("review the diff")).toBe("review the diff");
    expect(prefillQuickPromptName("look at [demo.ts](src/demo.ts) please")).toBe(
      "look at demo.ts please",
    );
    const long = "word ".repeat(30);
    const name = prefillQuickPromptName(long);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(" ")).toBe(false);
  });

  it("requires a non-empty name of at most 40 characters after trimming (rule 15)", () => {
    expect(isValidQuickPromptName("  ")).toBe(false);
    expect(isValidQuickPromptName("a".repeat(40))).toBe(true);
    expect(isValidQuickPromptName(`  ${"a".repeat(40)}  `)).toBe(true);
    expect(isValidQuickPromptName("a".repeat(41))).toBe(false);
  });

  it("sends only with a modifier and an empty draft (rule 8, scenario 3)", () => {
    expect(resolveQuickPromptChipAction({ modifierPressed: true, draftEmpty: true })).toBe(
      "insert-and-send",
    );
    expect(resolveQuickPromptChipAction({ modifierPressed: true, draftEmpty: false })).toBe(
      "insert",
    );
    expect(resolveQuickPromptChipAction({ modifierPressed: false, draftEmpty: true })).toBe(
      "insert",
    );
  });
});

describe("project identity (never derived from a path)", () => {
  it("keeps hostId and projectId as a pair and treats legacy or missing ids as no project (rule 2)", () => {
    expect(quickPromptProjectRefOf({ projectId: "p:1", hostId: "h:2" })).toEqual({
      projectId: "p:1",
      hostId: "h:2",
    });
    expect(quickPromptProjectRefOf({ projectId: null, hostId: "h" })).toBeNull();
    expect(quickPromptProjectRefOf({ projectId: "p", hostId: undefined })).toBeNull();
    expect(
      quickPromptProjectRefOf({ projectId: "p", hostId: "h", legacySingleRoot: true }),
    ).toBeNull();
  });
});

describe("portable global bodies", () => {
  it("drops the local path of user and plugin skills and keeps workspace skills as they are", () => {
    const nodes = JSON.stringify([
      {
        type: "paragraph",
        children: [
          {
            type: "prompt-mention",
            category: "skills",
            value: "code-review",
            markdown: "[$code-review](/Users/me/.claude/skills/code-review/SKILL.md)",
            data: { scope: "user", path: "/Users/me/.claude/skills/code-review/SKILL.md" },
          },
          {
            type: "prompt-mention",
            category: "skills",
            value: "pdf",
            markdown: "[$pdf](/plugins/pdf/SKILL.md)",
            data: { scope: "plugin", path: "/plugins/pdf/SKILL.md" },
          },
        ],
      },
    ]);
    const markdown =
      "run [$code-review](/Users/me/.claude/skills/code-review/SKILL.md) and [$pdf](/plugins/pdf/SKILL.md)";
    const portable = toPortableGlobalBody({ markdown, nodes });
    expect(portable.markdown).toBe("run $code-review and $pdf");
    const parsed = JSON.parse(portable.nodes) as Array<{
      children: Array<{ markdown: string; data: Record<string, unknown> }>;
    }>;
    expect(parsed[0]?.children[0]?.markdown).toBe("$code-review");
    expect(parsed[0]?.children[0]?.data).toEqual({ scope: "user" });
    expect(parsed[0]?.children[1]?.data).toEqual({ scope: "plugin" });
    expect(findQuickPromptGlobalBlockers(portable.nodes)).toEqual([]);
  });

  it("leaves workspace skills, files and bodies without skill mentions untouched", () => {
    const nodes = JSON.stringify([
      { type: "paragraph", children: [{ type: "text", text: "plain" }] },
    ]);
    expect(toPortableGlobalBody({ markdown: "plain", nodes })).toEqual({
      markdown: "plain",
      nodes,
    });
  });
});

describe("body presence and service error mapping (spec rules 14, 15)", () => {
  it("counts a body as present only when it has visible text", () => {
    expect(isQuickPromptBodyPresent("")).toBe(false);
    expect(isQuickPromptBodyPresent(" \n\t ")).toBe(false);
    expect(isQuickPromptBodyPresent("review")).toBe(true);
    expect(isQuickPromptBodyPresent("[demo.ts](src/demo.ts)")).toBe(true);
  });

  it("maps the empty-body service code to its own message and keeps the generic fallback", () => {
    expect(quickPromptErrorMessageId(new Error("quick-prompt.body-required"))).toBe(
      "quickPrompts.errors.bodyRequired",
    );
    expect(quickPromptErrorMessageId(new Error("something else"))).toBe(
      "quickPrompts.errors.action",
    );
  });
});
