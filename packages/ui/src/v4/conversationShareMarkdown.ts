import {
  findMarkdownCodeRanges,
  overlapsAssistantTextRanges,
  type AssistantTextRange,
} from "@/lib/assistantDirectiveParser.js";
import { extractZCodeFileCitationDirectives } from "@/lib/zcodeFileCitation.js";

function resolveCitationFileName(path: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/");
  return normalizedPath.split("/").at(-1) ?? normalizedPath;
}

/**
 * Image syntax `![alt](dest ...)`. dest may be wrapped in `<...>` (and contain spaces) or be a bare URL;
 * preserve an optional trailing title verbatim — remove only the initial `!`, leaving all other bytes unchanged.
 */
const markdownImagePattern = /!(\[[^\]]*\]\((?:<[^>\n]*>|[^)\s]*)(?:[^)\n]*)\))/gu;

/** Image addresses that make a visitor's browser request a third party: absolute http(s) and protocol-relative `//host`. */
function isRemoteImageDestination(destination: string): boolean {
  const trimmed = destination.trim().replace(/^<|>$/gu, "");
  return /^(?:https?:)?\/\//iu.test(trimmed);
}

function readImageDestination(imageSyntax: string): string {
  // imageSyntax has the form `[alt](dest "title")`; take the part after the first `(` through the first whitespace or end.
  const open = imageSyntax.indexOf("(");
  const inner = imageSyntax.slice(open + 1, -1);
  if (inner.startsWith("<")) return inner.slice(0, inner.indexOf(">") + 1);
  const whitespace = inner.search(/\s/u);
  return whitespace < 0 ? inner : inner.slice(0, whitespace);
}

/**
 * Downgrade remote images to ordinary links.
 *
 * The public share page (ConversationShareReadonlyTimeline) does not pass workspacePath /
 * sessionId / readAttachment, so MarkdownImage falls back to `displaySrc = resolvedSrc`
 * and renders `<img src={remote} loading="lazy">`. Any anonymous visitor opening the page would then automatically request the publisher-selected third party,
 * leaking IP / UA / Referer — equivalent to a publisher-controlled tracking
 * pixel. This streamdown version has no allowedImagePrefixes option (and linkSafety is disabled),
 * so strip images at the only public projection choke point: `![alt](url)` → `[alt](url)`,
 * which avoids automatic requests without losing information; the visitor loads the image only by clicking, and this also applies immediately to existing shares.
 * Handle only http(s) and protocol-relative addresses: data: does not use the network, and relative paths resolve to the same origin.
 */
function degradeRemoteImages(
  markdown: string,
  protectedRanges: readonly AssistantTextRange[],
): string {
  const matches = [...markdown.matchAll(markdownImagePattern)].filter(
    (match) =>
      !overlapsAssistantTextRanges(match.index, match.index + match[0].length, protectedRanges) &&
      isRemoteImageDestination(readImageDestination(match[1]!)),
  );
  let result = markdown;
  // Replace from right to left so earlier edits do not invalidate later indexes.
  for (const match of matches.reverse()) {
    result = `${result.slice(0, match.index)}${match[1]!}${result.slice(match.index + match[0].length)}`;
  }
  return result;
}

/**
 * Do not pass local citation directives in share content directly to MessageResponse: they expose paths
 * and may be interpreted as file operations when workspace authority is available. The public projection keeps only the uniquely matched
 * artifact display name; the directive parser protects protocol examples inside code blocks and preserves them verbatim.
 *
 * Also strip automatic loading of remote images; see degradeRemoteImages.
 */
export function normalizeConversationShareMarkdown(
  markdown: string,
  artifactNames: ReadonlyMap<string, string> = new Map(),
): string {
  const protectedRanges = findMarkdownCodeRanges(markdown);
  const directives = extractZCodeFileCitationDirectives(markdown).filter(
    (directive) => !overlapsAssistantTextRanges(directive.start, directive.end, protectedRanges),
  );

  let result = markdown;
  for (const directive of [...directives].reverse()) {
    const fileName = directive.path ? resolveCitationFileName(directive.path) : "";
    const candidates = [...artifactNames.values()].filter(
      (displayName) => displayName.trim().toLowerCase() === fileName.toLowerCase(),
    );
    const replacement = candidates.length === 1 ? candidates[0]!.trim() : "";
    result = `${result.slice(0, directive.start)}${replacement}${result.slice(directive.end)}`;
  }
  // Citation removal only shortens the body and does not create new image syntax, but code fence ranges may shift left,
  // so recompute protected ranges from the rewritten body before downgrading images.
  return degradeRemoteImages(result, findMarkdownCodeRanges(result));
}
