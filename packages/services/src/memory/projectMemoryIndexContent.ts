const PROJECT_MEMORY_INDEX_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/;
const PROJECT_MEMORY_INDEX_HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

function stripProjectMemoryIndexHtmlComments(content: string): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let inComment = false;
  let pendingCommentLines: string[] | undefined;
  let result = "";

  for (const line of lines) {
    const lineContent = line.replace(/\r?\n$/u, "");
    const lineEnding = line.slice(lineContent.length);
    if (inComment) {
      const commentEnd = lineContent.indexOf("-->");
      if (commentEnd === -1) {
        pendingCommentLines!.push(line);
        continue;
      }
      inComment = false;
      pendingCommentLines = undefined;
      result +=
        lineContent.slice(commentEnd + 3).replace(PROJECT_MEMORY_INDEX_HTML_COMMENT_PATTERN, "") +
        lineEnding;
      continue;
    }

    if (fence) {
      const closingFence = new RegExp(
        `^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
        "u",
      );
      if (closingFence.test(lineContent)) {
        fence = undefined;
      }
      result += line;
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(lineContent)?.[1];
    if (openingFence) {
      fence = { marker: openingFence[0] as "`" | "~", length: openingFence.length };
      result += line;
      continue;
    }

    const commentPrefix = /^ {0,3}<!--/u.exec(lineContent)?.[0];
    if (commentPrefix) {
      const commentEnd = lineContent.indexOf("-->", commentPrefix.length);
      if (commentEnd === -1) {
        inComment = true;
        pendingCommentLines = [line];
        continue;
      }
      result +=
        lineContent.slice(commentEnd + 3).replace(PROJECT_MEMORY_INDEX_HTML_COMMENT_PATTERN, "") +
        lineEnding;
      continue;
    }

    result += line;
  }

  // The CLI's Markdown lexer keeps an unterminated comment token, so retain its original lines.
  if (pendingCommentLines) {
    result += pendingCommentLines.join("");
  }
  return result;
}

export function readProjectMemoryIndexLineCount(content: string): number {
  // Keep this normalization aligned with formatProjectMemoryIndexContent in the CLI: remove
  // leading frontmatter and complete top-level HTML comments before trimming and counting.
  const trimmed = stripProjectMemoryIndexHtmlComments(
    content.replace(PROJECT_MEMORY_INDEX_FRONTMATTER_PATTERN, ""),
  ).trim();
  return trimmed ? trimmed.split("\n").length : 0;
}
