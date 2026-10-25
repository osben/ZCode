/**
 * Pure quick prompt rules (specs/composer-quick-prompts.md). No React, no IO: every decision the composer,
 * the "/" panel and the dialogs make about a snapshot is computed here so it can be unit-tested directly.
 */
import {
  LEGACY_SINGLE_ROOT_PROJECT_PREFIX,
  QUICK_PROMPT_BODY_MAX_LENGTH,
  QUICK_PROMPT_COLORS,
  QUICK_PROMPT_LIST_LIMIT,
  QUICK_PROMPT_NAME_MAX_LENGTH,
  findQuickPromptGlobalBlockers,
  type QuickPrompt,
  type QuickPromptColor,
  type QuickPromptProjectRef,
  type QuickPromptScope,
  type QuickPromptSnapshot,
} from "./contract.js";
import type { QuickPromptSlashItem } from "@/slashCommandHelpers.js";
import type { SerializedPromptBody } from "@/prompt-body/index.js";
import { quickPromptProjectKey } from "@/quick-prompts/reader.js";

/** Rule 22: the picker order; "none" is a separate swatch and is not a palette member. */
export const QUICK_PROMPT_COLOR_OPTIONS: readonly QuickPromptColor[] = QUICK_PROMPT_COLORS;

/**
 * Rule 22/23: the design token that paints a color's dot. A static map, so no class or variable name is ever built
 * from data. Legacy and unknown values (null) have no dot.
 */
const QUICK_PROMPT_COLOR_VARS: Record<QuickPromptColor, string> = {
  red: "var(--color-quick-prompt-red)",
  orange: "var(--color-quick-prompt-orange)",
  yellow: "var(--color-quick-prompt-yellow)",
  green: "var(--color-quick-prompt-green)",
  blue: "var(--color-quick-prompt-blue)",
  violet: "var(--color-quick-prompt-violet)",
  pink: "var(--color-quick-prompt-pink)",
};

export function quickPromptColorVar(color: QuickPromptColor | null | undefined): string | null {
  return color ? (QUICK_PROMPT_COLOR_VARS[color] ?? null) : null;
}

/** i18n key of the swatch's accessible name; null (none) has its own key. */
export function quickPromptColorMessageId(color: QuickPromptColor | null): string {
  return color ? `quickPrompts.color.${color}` : "quickPrompts.color.none";
}

/** Rule 2: pinned globals not hidden in the project, in global order, then the project's pinned quick prompts. */
export function composeQuickPromptRow(snapshot: QuickPromptSnapshot | null): QuickPrompt[] {
  if (!snapshot) return [];
  return [
    ...snapshot.globals.filter((prompt) => prompt.pinned && !prompt.hiddenInProject),
    ...snapshot.projectPrompts.filter((prompt) => prompt.pinned),
  ];
}

/** Rule 4: every quick prompt available in the session, pinned or not. */
export function composeQuickPromptSlashItems(
  snapshot: QuickPromptSnapshot | null,
): QuickPromptSlashItem[] {
  if (!snapshot) return [];
  return [
    ...snapshot.globals.filter((prompt) => !prompt.hiddenInProject),
    ...snapshot.projectPrompts,
  ].map((prompt) => ({
    promptId: prompt.promptId,
    name: prompt.name,
    text: prompt.body.markdown,
    nodes: prompt.body.nodes,
  }));
}

/** Rule 6: the first-run state is "no quick prompt at all", not "nothing pinned". */
export function isQuickPromptFirstRun(snapshot: QuickPromptSnapshot | null): boolean {
  return snapshot !== null && snapshot.globals.length === 0 && snapshot.projectPrompts.length === 0;
}

/** Rule 13: a session with a project creates project quick prompts; one without creates globals. */
export function defaultQuickPromptScope(project: QuickPromptProjectRef | null): QuickPromptScope {
  return project ? "project" : "global";
}

/**
 * Rule 12 and rule 18: which scopes are blocked for a candidate body. Empty list = the scope is allowed.
 * `bodyNodes` null means the caller is not creating a body (for example a rename), so only limits apply.
 */
export type QuickPromptScopeBlock = "no-project" | "global-mention" | "limit";

export function quickPromptScopeBlocks(input: {
  scope: QuickPromptScope;
  project: QuickPromptProjectRef | null;
  bodyNodes: string | null;
  snapshot: QuickPromptSnapshot | null;
}): QuickPromptScopeBlock[] {
  const blocks: QuickPromptScopeBlock[] = [];
  if (input.scope === "global") {
    if (input.bodyNodes !== null && findQuickPromptGlobalBlockers(input.bodyNodes).length > 0) {
      blocks.push("global-mention");
    }
    if ((input.snapshot?.globals.length ?? 0) >= QUICK_PROMPT_LIST_LIMIT) blocks.push("limit");
  } else {
    if (!input.project) blocks.push("no-project");
    if ((input.snapshot?.projectPrompts.length ?? 0) >= QUICK_PROMPT_LIST_LIMIT)
      blocks.push("limit");
  }
  return blocks;
}

/** i18n key of the explanation shown when a scope is blocked (rules 12, 13 and 18). */
export function quickPromptBlockMessageId(block: QuickPromptScopeBlock): string {
  switch (block) {
    case "no-project":
      return "quickPrompts.scope.noProject";
    case "global-mention":
      return "quickPrompts.scope.globalBlocked";
    case "limit":
      return "quickPrompts.limit.reached";
  }
}

/**
 * A global body must work in any workspace, including remote ones. User and plugin skills live on the desktop, so
 * their mention keeps no file path: the Skill tool resolves skills by name, and a path would point nowhere remote.
 * Markdown and the stored nodes are rewritten together so the send text and the chip stay consistent.
 */
export function toPortableGlobalBody(body: SerializedPromptBody): SerializedPromptBody {
  const nodes: unknown = JSON.parse(body.nodes);
  let markdown = body.markdown;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "prompt-mention" && record.category === "skills") {
      const data = record.data as Record<string, unknown> | null | undefined;
      if (
        data &&
        (data.scope === "user" || data.scope === "plugin") &&
        typeof data.path === "string"
      ) {
        const nextMarkdown = `$${String(record.value)}`;
        if (typeof record.markdown === "string" && record.markdown) {
          markdown = markdown.split(record.markdown).join(nextMarkdown);
        }
        delete data.path;
        record.markdown = nextMarkdown;
      }
    }
    if (Array.isArray(record.children)) record.children.forEach(visit);
  };
  if (Array.isArray(nodes)) nodes.forEach(visit);
  return { markdown, nodes: JSON.stringify(nodes) };
}

/** One-line preview of a body: mention links show their label and whitespace collapses to single spaces. */
export function quickPromptPreviewText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rule 15: name required, at most 40 characters after trimming. */
export function isValidQuickPromptName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= QUICK_PROMPT_NAME_MAX_LENGTH;
}

/** Rule 15 and the service rule: a body needs visible text. Mirrors the service check (quick-prompt.body-required). */
export function isQuickPromptBodyPresent(markdown: string): boolean {
  return markdown.trim().length > 0;
}

/** Rule 18: body limit on canonical text. */
export function isQuickPromptBodyWithinLimit(markdown: string): boolean {
  return markdown.length <= QUICK_PROMPT_BODY_MAX_LENGTH;
}

/** Rule 8: ⌘/Ctrl-click sends only when the composer has nothing to submit; otherwise it only inserts. */
export function resolveQuickPromptChipAction(input: {
  modifierPressed: boolean;
  draftEmpty: boolean;
}): "insert" | "insert-and-send" {
  return input.modifierPressed && input.draftEmpty ? "insert-and-send" : "insert";
}

/**
 * Project identity is the (hostId, projectId) pair (spec: stored in two columns). A missing id or a legacy
 * single-root project is treated as "no project": only pinned globals apply there.
 */
export function quickPromptProjectRefOf(input: {
  projectId: string | null | undefined;
  hostId: string | null | undefined;
  legacySingleRoot?: boolean;
}): QuickPromptProjectRef | null {
  if (!input.projectId || !input.hostId || input.legacySingleRoot) return null;
  return { hostId: input.hostId, projectId: input.projectId };
}

export function sameQuickPromptProject(
  left: QuickPromptProjectRef | null,
  right: QuickPromptProjectRef | null,
): boolean {
  return left?.hostId === right?.hostId && left?.projectId === right?.projectId;
}

export function isLegacySingleRootProjectId(projectId: string): boolean {
  return projectId.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX);
}

/** The project fields the Settings picker needs; structural so the model does not depend on the project storage types. */
export interface QuickPromptProjectCandidate {
  id: string;
  hostId: string;
  name: string;
  deleted?: boolean;
  legacySingleRoot?: true;
}

export interface QuickPromptProjectOption {
  key: string;
  project: QuickPromptProjectRef;
  /** Null when the project is no longer in the project tree; its quick prompts still exist (rule 19). */
  name: string | null;
  available: boolean;
}

/**
 * Settings project picker (rule 19): tree projects in tree order, then projects that only own quick prompts as
 * unavailable. Legacy single-root projects are never offered. Identity is the (hostId, projectId) pair.
 */
export function buildQuickPromptProjectOptions(input: {
  projects: readonly QuickPromptProjectCandidate[];
  refs: readonly QuickPromptProjectRef[];
}): QuickPromptProjectOption[] {
  const options: QuickPromptProjectOption[] = [];
  const seen = new Set<string>();
  for (const candidate of input.projects) {
    if (candidate.deleted || candidate.legacySingleRoot) continue;
    if (isLegacySingleRootProjectId(candidate.id)) continue;
    const project = { hostId: candidate.hostId, projectId: candidate.id };
    const key = quickPromptProjectKey(project);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, project, name: candidate.name, available: true });
  }
  for (const ref of input.refs) {
    if (isLegacySingleRootProjectId(ref.projectId)) continue;
    const key = quickPromptProjectKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      key,
      project: { hostId: ref.hostId, projectId: ref.projectId },
      name: null,
      available: false,
    });
  }
  return options;
}

/** Moves `activeId` to the position currently held by `overId`. Unknown or identical ids leave the order unchanged. */
export function moveQuickPromptId(
  ids: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  const next = [...ids];
  if (from < 0 || to < 0 || from === to) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * Localized message for a service failure. The service reports stable `quick-prompt.*` codes in the error message
 * (contract.ts); the raw code never reaches the user. Unknown failures get the fallback message.
 */
const QUICK_PROMPT_ERROR_MESSAGE_IDS: ReadonlyArray<readonly [string, string]> = [
  ["quick-prompt.name-required", "quickPrompts.errors.nameInvalid"],
  ["quick-prompt.name-too-long", "quickPrompts.errors.nameInvalid"],
  ["quick-prompt.body-too-long", "quickPrompts.errors.bodyTooLong"],
  ["quick-prompt.body-required", "quickPrompts.errors.bodyRequired"],
  ["quick-prompt.global-mention-blocked", "quickPrompts.scope.globalBlocked"],
  ["quick-prompt.limit-reached", "quickPrompts.limit.reached"],
  ["quick-prompt.not-found", "quickPrompts.errors.notFound"],
  ["quick-prompt.reorder-mismatch", "quickPrompts.errors.reorder"],
  ["quick-prompt.read-only", "quickPrompts.errors.readOnly"],
];

export function quickPromptErrorMessageId(
  cause: unknown,
  fallback = "quickPrompts.errors.action",
): string {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  for (const [code, messageId] of QUICK_PROMPT_ERROR_MESSAGE_IDS) {
    if (message.includes(code)) return messageId;
  }
  return fallback;
}
