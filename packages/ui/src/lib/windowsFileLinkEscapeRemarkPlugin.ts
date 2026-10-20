import type { Plugin } from "unified";

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
}

// Drive-letter absolute paths and UNC paths. Only these use the raw source slice; ordinary URLs are never rewritten by this plugin.
// UNC requires only one leading backslash here: in source `\\host`, `\\` is itself a punctuation escape,
// leaving one backslash after parsing. Requiring two would miss every UNC path that needs restoration.
const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

// CommonMark: in a link destination, `\X` produces X only when X is ASCII punctuation; otherwise it is preserved as-is.
// The four ranges are !-/、:-@、[-`、{-~, which together cover all ASCII punctuation.
const punctuationEscapePattern = /\\([!-/:-@[-`{-~])/gu;

function unescapeCommonMarkPunctuation(raw: string): string {
  return raw.replace(punctuationEscapePattern, "$1");
}

/**
 * Extract the raw destination according to the node shape.
 *
 * - Inline `link` / `image`: `[label](dest)` / `![alt](dest)`; take the text before the closing `)`.
 *   Windows paths do not contain `](`, so taking the last separator after the gate is safe; this also prevents square brackets
 *   inside label/alt from shifting the slice.
 * - `definition`: `[ref]: dest`; take the text after `]:`. Reference-style link URLs come from the definition,
 *   where the same escape loss occurs and must also be restored.
 */
function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    return marker < 0 ? null : slice.slice(marker + 2).trim();
  }

  if (!slice.endsWith(")")) return null;
  const marker = slice.lastIndexOf("](");
  return marker < 0 ? null : slice.slice(marker + 2, -1).trim();
}

/**
 * Retrieve the node's destination from the VFile source before escape processing.
 *
 * During remark-parse, `[x](C:\Users\developer\.zcode\a.png)` consumes `\.`
 * as an escaped punctuation mark (`\U`, `\z`, and `\w` survive because the next character is not punctuation), so mdast receives
 * `C:\Users\developer.zcode\a.png`. The loss happens while parsing; existing rewrite plugins at the rehype stage
 * see only the damaged string and cannot restore it, so this must run during remark.
 *
 * Treat the slice as correct and restoration as unambiguous only if “the source after CommonMark unescaping exactly equals node.url”; otherwise
 * leave it unchanged rather than write a potentially incorrect path.
 */
function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  // Links with titles require parsing quote syntax to locate the destination end; a bad slice would include quotes
  // in the path. This case does not occur here, so skip restoration.
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  // Angle-bracket destinations have different escape rules from bare destinations, so skip restoration here too.
  if (raw === null || !raw || raw.startsWith("<") || raw === url) return null;
  if (unescapeCommonMarkPunctuation(raw) !== url) return null;

  return raw;
}

export const windowsFileLinkEscapeRemarkPlugin: Plugin =
  function windowsFileLinkEscapeRemarkPlugin() {
    return (tree: unknown, file: unknown) => {
      const source = String(file ?? "");
      if (!source) return;

      const visit = (node: MarkdownNode): void => {
        if (node.type === "link" || node.type === "image" || node.type === "definition") {
          const raw = recoverRawDestination(node, source);
          if (raw !== null) node.url = raw;
        }

        node.children?.forEach(visit);
      };

      visit(tree as MarkdownNode);
    };
  };
