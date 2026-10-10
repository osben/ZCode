import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLocalizedText } from "@zcode/shared";
import {
  resolveSkillDisplayDescription,
  resolveSkillSourceLabel,
} from "../src/lib/builtinSkillI18n.js";
import { formatConversationShareAllowedArtifacts } from "../src/lib/conversationShareError.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowPromotePrompt,
} from "../src/settings/saved-workflows/savedWorkflowLaunchPrompt.js";

const CYRILLIC = /[\u0400-\u04FF]/u;

describe("uk content catalogs", () => {
  it("translates official builtin skill descriptions and source labels", () => {
    const skill = {
      name: "systematic-debugging",
      description: "raw",
      path: "/x/zcode-plugins-official/superpowers/skills/systematic-debugging/SKILL.md",
      scope: "plugin" as const,
      pluginName: "superpowers",
    };
    assert.match(resolveSkillDisplayDescription(skill, "uk-UA"), CYRILLIC);
    assert.equal(
      resolveSkillDisplayDescription(skill, "en-US"),
      "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
    );
    assert.equal(resolveSkillSourceLabel("plugin", "uk-UA"), "Плагін");
    assert.equal(resolveSkillSourceLabel("plugin", "en-US"), "Plugin");
  });

  it("localizes share artifact labels and keeps zh/en output", () => {
    const issue = { allowedArtifacts: [{ type: "docx" }, { type: "image" }] } as never;
    assert.equal(
      formatConversationShareAllowedArtifacts(issue, "uk-UA"),
      "документ Word, зображення",
    );
    assert.equal(formatConversationShareAllowedArtifacts(issue, "en-US"), "Word document, image");
    assert.equal(formatConversationShareAllowedArtifacts(issue, "zh-CN"), "Word 文档、图片");
    assert.equal(
      formatConversationShareAllowedArtifacts({} as never, "uk-UA"),
      "тимчасово недоступно",
    );
  });

  it("prefills saved workflow prompts in Ukrainian", () => {
    assert.match(buildSavedWorkflowCreatePrompt("uk-UA"), CYRILLIC);
    assert.match(buildSavedWorkflowCreatePrompt("uk-UA", "global"), /scope: "global"/u);
    assert.match(
      buildSavedWorkflowPromotePrompt({ name: "a", path: "b", locale: "uk-UA" }),
      CYRILLIC,
    );
    assert.doesNotMatch(buildSavedWorkflowCreatePrompt("en-US"), CYRILLIC);
  });

  it("resolves plugin i18n maps by the uk language prefix", () => {
    assert.equal(resolveLocalizedText("uk-UA", "base", { uk: "укр" }), "укр");
    assert.equal(resolveLocalizedText("uk-UA", "base", { "zh-CN": "中文" }), "base");
  });
});
