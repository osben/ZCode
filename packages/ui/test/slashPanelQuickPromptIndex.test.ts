// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import { buildVirtualRows, type MentionPanelSection } from "@/mentions/components/MentionPanel.js";
import {
  buildSlashFlatSuggestions,
  useSlashCommandMentionPanelSections,
} from "@/slashCommandPanelSections.js";

afterEach(cleanup);

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
} as unknown as IntlInstance;

function item(
  id: string,
  trigger: PromptInputSuggestionItem["trigger"],
): PromptInputSuggestionItem {
  return { id, trigger, value: id, label: id, description: `${id} description` };
}

/** Renders the hook once and returns the sections it builds. */
function buildSections(input: {
  commands: PromptInputSuggestionItem[];
  skills: PromptInputSuggestionItem[];
  skillsLoading?: boolean;
  skillsError?: string | null;
  subagents: PromptInputSuggestionItem[];
  quickPrompts?: PromptInputSuggestionItem[];
}): MentionPanelSection[] {
  const holder: { sections: MentionPanelSection[] | null } = { sections: null };
  function Probe() {
    holder.sections = useSlashCommandMentionPanelSections(
      intl,
      input.commands.length,
      input.commands,
      input.skills,
      input.skillsLoading ?? false,
      input.skillsError ?? null,
      input.subagents,
      false,
      null,
      input.quickPrompts,
    );
    return null;
  }
  render(createElement(Probe));
  if (!holder.sections) throw new Error("sections not built");
  return holder.sections;
}

/** Option ids in the order the keyboard index addresses them, as the panel renders them. */
function flatOptionIds(sections: MentionPanelSection[]): string[] {
  return buildVirtualRows(sections)
    .flatMap((row) => (row.kind === "option" ? [row] : []))
    .sort((left, right) => left.flatOptionIndex - right.flatOptionIndex)
    .map((row) => row.option.id);
}

describe("'/' panel flat keyboard index with the Quick prompts section", () => {
  const commands = [item("compact", "/"), item("review", "/")];
  const skills = [item("skill-a", "$")];
  const subagents = [item("explorer", "#")];
  const quickPrompts = [item("qp-review-diff", "/"), item("qp-write-tests", "/")];

  it("adds the quick prompts section last, after commands, skills and subagents", () => {
    const sections = buildSections({ commands, skills, subagents, quickPrompts });
    expect(sections.map((section) => section.id)).toEqual([
      "commands",
      "skills",
      "subagents",
      "quick-prompts",
    ]);
  });

  it("the flat index addresses the same items, in the same order, as the plugin's flat suggestion list", () => {
    const sections = buildSections({ commands, skills, subagents, quickPrompts });
    // SlashCommandPlugin builds its flat list as [...commands, ...skills, ...subagents, ...quickPrompts].
    expect(flatOptionIds(sections)).toEqual([
      ...commands.map((entry) => entry.id),
      ...skills.map((entry) => entry.id),
      ...subagents.map((entry) => entry.id),
      ...quickPrompts.map((entry) => entry.id),
    ]);
  });

  it("omits the section entirely when quick prompts are not offered, so the index does not count them", () => {
    const sections = buildSections({ commands, skills, subagents, quickPrompts: undefined });
    expect(sections.map((section) => section.id)).not.toContain("quick-prompts");
    expect(flatOptionIds(sections)).toEqual([
      ...commands.map((entry) => entry.id),
      ...skills.map((entry) => entry.id),
      ...subagents.map((entry) => entry.id),
    ]);
  });

  it("keeps the empty quick prompts section as a status row, not as options", () => {
    const sections = buildSections({ commands, skills, subagents, quickPrompts: [] });
    const rows = buildVirtualRows(sections);
    expect(rows.some((row) => row.kind === "status" && row.sectionId === "quick-prompts")).toBe(
      true,
    );
    expect(flatOptionIds(sections)).toHaveLength(
      commands.length + skills.length + subagents.length,
    );
  });

  it("the plugin's flat list (buildSlashFlatSuggestions) matches the rendered option order", () => {
    const sections = buildSections({ commands, skills, subagents, quickPrompts });
    const flat = buildSlashFlatSuggestions({
      commands,
      skills,
      skillsLoading: false,
      skillsError: null,
      subagents,
      subagentsLoading: false,
      subagentsError: null,
      quickPrompts,
    });
    expect(flat.map((entry) => entry.id)).toEqual(flatOptionIds(sections));
  });

  it.each([
    { skillsLoading: true, skillsError: null },
    { skillsLoading: false, skillsError: "boom" },
  ])(
    "a skills section showing a status row ($skillsLoading, $skillsError) does not shift the quick prompts' index",
    ({ skillsLoading, skillsError }) => {
      const sections = buildSections({
        commands,
        skills,
        skillsLoading,
        skillsError,
        subagents,
        quickPrompts,
      });
      const flat = buildSlashFlatSuggestions({
        commands,
        skills,
        skillsLoading,
        skillsError,
        subagents,
        subagentsLoading: false,
        subagentsError: null,
        quickPrompts,
      });
      expect(flat.map((entry) => entry.id)).toEqual(flatOptionIds(sections));
    },
  );
});
