import type { DefinitionPreviewReadParams, DefinitionPreviewRef } from "./contract.js";

export const exampleDefinitionPreviewRef: DefinitionPreviewRef = {
  kind: "skill",
  name: "skill-creator",
  hintPath: "/home/user/.zcode/skills/skill-creator/SKILL.md",
  workspacePath: "/workspace",
  workspaceIdentity: "/workspace",
};

export const exampleDefinitionPreviewRead: DefinitionPreviewReadParams = {
  ref: exampleDefinitionPreviewRef,
  relativePath: "references/schemas.md",
};
