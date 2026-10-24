import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/** Spec: specs/composer-quick-prompts.md. */
export type QuickPromptScope = "global" | "project";

/** Project identity is the (hostId, projectId) pair; never encode it into one string or derive it from a path. */
export interface QuickPromptProjectRef {
  hostId: string;
  projectId: string;
}

/** Color labels (spec rule 22): a fixed palette; "none" is the absence of a value (null), not a member. */
export const QUICK_PROMPT_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "pink",
] as const;
export type QuickPromptColor = (typeof QUICK_PROMPT_COLORS)[number];

/** Reads of the stored column: any value outside the palette (unknown hue, empty, non-string) is "none". */
export function normalizeQuickPromptColor(value: unknown): QuickPromptColor | null {
  return typeof value === "string" && (QUICK_PROMPT_COLORS as readonly string[]).includes(value)
    ? (value as QuickPromptColor)
    : null;
}

export interface QuickPromptBody {
  /** Canonical prompt markdown ($getPromptMarkdown) used for preview, search and send. */
  markdown: string;
  /** JSON array of serialized Lexical paragraph nodes; restores mention chips on insert. */
  nodes: string;
}

export interface QuickPrompt {
  promptId: string;
  scope: QuickPromptScope;
  /** null for global quick prompts. */
  project: QuickPromptProjectRef | null;
  name: string;
  body: QuickPromptBody;
  /** Optional label color; null = none (legacy prompts, unknown stored values). */
  color: QuickPromptColor | null;
  pinned: boolean;
  /** Order within its list (globals, or one project's quick prompts). */
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface QuickPromptSnapshot {
  project: QuickPromptProjectRef | null;
  /** Every global quick prompt in order; hiddenInProject is always false when project is null. */
  globals: Array<QuickPrompt & { hiddenInProject: boolean }>;
  /** The project's quick prompts in order; empty when project is null. */
  projectPrompts: QuickPrompt[];
}

export interface QuickPromptCreateInput {
  scope: QuickPromptScope;
  project: QuickPromptProjectRef | null;
  name: string;
  body: QuickPromptBody;
  color?: QuickPromptColor | null;
  pinned: boolean;
}

export interface QuickPromptUpdateInput {
  promptId: string;
  name?: string;
  body?: QuickPromptBody;
  /** undefined = unchanged, null = clear. */
  color?: QuickPromptColor | null;
  /** Changing scope moves the quick prompt to the end of the target list. */
  scope?: QuickPromptScope;
  project?: QuickPromptProjectRef | null;
}

export interface IQuickPromptService {
  /** Globals (with the hidden mark for project) and the project's quick prompts. No side effects. */
  read(input: { project: QuickPromptProjectRef | null }): Promise<QuickPromptSnapshot>;
  /** Projects that own at least one quick prompt (Settings lists unavailable ones too). */
  readProjects(): Promise<QuickPromptProjectRef[]>;
  create(input: QuickPromptCreateInput): Promise<QuickPrompt>;
  update(input: QuickPromptUpdateInput): Promise<QuickPrompt>;
  /** Also deletes the quick prompt's hidden marks. */
  delete(input: { promptId: string }): Promise<void>;
  /** Independent copy appended to the target list. */
  duplicate(input: {
    promptId: string;
    scope: QuickPromptScope;
    project: QuickPromptProjectRef | null;
  }): Promise<QuickPrompt>;
  setPinned(input: { promptId: string; pinned: boolean }): Promise<void>;
  /** Only global quick prompts can be hidden in a project. */
  setHidden(input: {
    promptId: string;
    project: QuickPromptProjectRef;
    hidden: boolean;
  }): Promise<void>;
  /** orderedIds must be exactly the current members of that list. */
  reorder(input: {
    scope: QuickPromptScope;
    project: QuickPromptProjectRef | null;
    orderedIds: string[];
  }): Promise<void>;
}

export const IQuickPromptService = createServiceDescriptor<IQuickPromptService>(
  ServiceChannels.QuickPrompts,
);

/** Broadcast after every committed write; the payload is empty and receivers re-read. */
export const QUICK_PROMPTS_CHANGED_CHANNEL = "state:quick-prompts";

export const QUICK_PROMPT_NAME_MAX_LENGTH = 40;
export const QUICK_PROMPT_BODY_MAX_LENGTH = 8000;
export const QUICK_PROMPT_LIST_LIMIT = 50;

/** Stable code of a mutation sent through a mobile (read-only) attachment. */
export const QUICK_PROMPT_READ_ONLY_ERROR = "quick-prompt.read-only";

type GlobalBlockReason = "file" | "workspace-skill" | "session" | "subagent" | "whiteboard";

interface SerializedNodeLike {
  type?: unknown;
  category?: unknown;
  data?: { scope?: unknown } | null;
  children?: unknown;
}

function collectGlobalBlockReasons(
  node: SerializedNodeLike,
  reasons: Set<GlobalBlockReason>,
): void {
  if (node.type === "prompt-mention") {
    switch (node.category) {
      case "files":
        reasons.add("file");
        break;
      case "whiteboards":
        reasons.add("whiteboard");
        break;
      case "sessions":
        reasons.add("session");
        break;
      case "subagents":
        reasons.add("subagent");
        break;
      case "skills":
        if (node.data?.scope === "workspace") reasons.add("workspace-skill");
        break;
      default:
        break;
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === "object") collectGlobalBlockReasons(child, reasons);
    }
  }
}

/**
 * Mentions that tie a body to one project (spec rule 12). Empty result = the body may be global.
 * Throws on malformed nodes JSON so callers reject the write instead of guessing.
 */
export function findQuickPromptGlobalBlockers(nodesJson: string): GlobalBlockReason[] {
  const parsed: unknown = JSON.parse(nodesJson);
  if (!Array.isArray(parsed)) throw new Error("quick prompt body nodes must be a JSON array");
  const reasons = new Set<GlobalBlockReason>();
  for (const node of parsed) {
    if (node && typeof node === "object") collectGlobalBlockReasons(node, reasons);
  }
  return [...reasons];
}
