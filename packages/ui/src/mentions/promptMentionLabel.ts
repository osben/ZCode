import type { MentionCategory } from "@/mentions/mentionTypes.js";

function unescapePromptMentionMarkdownText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }
    result += text[index];
  }
  return result;
}

function extractPromptMentionMarkdownLabel(text: string): string | null {
  // 修复依据：普通字符分支排除反斜杠，使转义分支与其互斥，避免恶意草稿触发灾难性回溯。
  const matched = /^\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>\\])*?)>|((?:\\.|[^)\\])*))\)$/.exec(
    text.trim(),
  );
  const label = matched?.[1];
  return label ? unescapePromptMentionMarkdownText(label) : null;
}

export function normalizePromptMentionDisplayLabel(
  category: MentionCategory,
  label: string,
  value: string,
): string {
  const markdownLabel = extractPromptMentionMarkdownLabel(label);
  let displayLabel = markdownLabel ?? label;

  if (category === "skills" && displayLabel.startsWith("$")) {
    displayLabel = displayLabel.slice(1);
  } else if (category === "sessions" && displayLabel.startsWith("#")) {
    displayLabel = displayLabel.slice(1);
  } else if (
    (category === "files" ||
      category === "subagents" ||
      category === "whiteboards" ||
      category === "plugins") &&
    displayLabel.startsWith("@")
  ) {
    displayLabel = displayLabel.slice(1);
  }

  // Older draft snapshots may store the complete markdown link in the mention node text field.
  // This leaves the tag icon after restoring, but displays the text as `[$skill](path)` The display layer uses only the human-readable label;
  // the markdown field keeps the full original text for sending.
  return displayLabel.trim() || value;
}
