import type { PromptInputTrigger } from "@/lib/promptInputTriggers.js";

export type MentionPanelGroupId = "plugins" | "files" | "sessions" | "whiteboards" | "skills";
export type SessionMentionWorkspaceScope = "current-workspace" | "same-authority-workspaces";

const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = [
  "plugins",
  "files",
  "sessions",
  "whiteboards",
];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];
const SKILL_GROUP_ORDER: readonly MentionPanelGroupId[] = ["skills"];

/**
 * Input triggers only choose the discovery entry point; they do not change the canonical mention after a candidate is selected.
 * `#` and `$` (including the input-normalized `¥` / `￥`) continue to use the old single-group panel.
 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") {
    return CONTEXT_GROUP_ORDER;
  }
  if (trigger === "#") {
    return SESSION_GROUP_ORDER;
  }
  if (trigger === "$") {
    return SKILL_GROUP_ORDER;
  }
  return [];
}

/**
 * Although `@` and `#` share the session provider, their product scopes differ.
 * If workspace scope were expanded unconditionally in the shared provider, `@` would expand as well; trigger routing must explicitly determine the scope.
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
