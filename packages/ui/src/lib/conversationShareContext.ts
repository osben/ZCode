const SHARE_CONTEXT_BLOCK_PATTERN =
  /(?:\n\n)?# zcode-share-context:\n```zcode-share-context\n([\s\S]*?)\n```\s*$/u;

export interface ConversationShareContextReference {
  contextId: string;
  shareUrl: string;
}

/**
 * Extract the share handover context that can still be attached from the session snapshot.
 *
 * Intentionally accept only the snapshot (no separate arguments): this path broke once — the composer read a parallel
 * sharedContextImport prop that SessionPane never passed, so the first message never included sharedContextRefs;
 * the CLI could not progress through pending→reserved→attached, and the model never received the shared content (while the read-only block still appeared at the top,
 * making the bug invisible). The composer always has the snapshot, so deriving from it prevents this wiring from being missed again.
 *
 * Return null for the legacy shape (title only, no contextId): without contextId, there is no way to build
 * sharedContextRefs, so attachment is impossible.
 */
export function resolveAttachableShareContext(
  sharedContextImport:
    | { contextId: string; title: string; shareUrl: string; status: string }
    | { title: string }
    | null
    | undefined,
): { contextId: string; title: string; shareUrl: string; status: string } | null {
  if (!sharedContextImport || !("contextId" in sharedContextImport)) return null;
  return sharedContextImport.status === "discarded" ? null : sharedContextImport;
}

function isReference(value: unknown): value is ConversationShareContextReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "contextId" && key !== "shareUrl")) return false;
  if (typeof candidate.contextId !== "string" || typeof candidate.shareUrl !== "string")
    return false;
  try {
    const url = new URL(candidate.shareUrl);
    return /^\/cn\/share\/[^/]+$/u.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Remove the trailing share URL block that may appear in historical messages from the visible body.
 *
 * This block is no longer produced: it was renderer-only (no consumers in CLI/shared), and its sole purpose
 * was to drive a chip that has since been removed, at the cost of putting the share URL in the body sent to the model. The write path is gone; keep this read path
 * only to prevent messages sent between the wiring fix and chip removal from showing raw markup in the body.
 */
export function parseConversationShareContext(text: string): {
  visibleContent: string;
  reference: ConversationShareContextReference | null;
} {
  const match = text.match(SHARE_CONTEXT_BLOCK_PATTERN);
  if (!match) return { visibleContent: text, reference: null };
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    return isReference(parsed)
      ? { visibleContent: text.slice(0, match.index).trimEnd(), reference: parsed }
      : { visibleContent: text, reference: null };
  } catch {
    return { visibleContent: text, reference: null };
  }
}
