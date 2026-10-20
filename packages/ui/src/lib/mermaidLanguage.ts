export function isMermaidLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

const MERMAID_AUTODETECT_LANGUAGES = new Set(["", "text", "txt", "plain"]);
const MERMAID_LEADING_DIRECTIVE_PATTERN = /^---[\s\S]*?---\s*/;
const MERMAID_DIAGRAM_START_PATTERN =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|c4(?:Context|Container|Component|Dynamic|Deployment))/i;

export function isLikelyMermaidCode(code: string): boolean {
  const firstMeaningfulLine = code
    .trim()
    .replace(MERMAID_LEADING_DIRECTIVE_PATTERN, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  return firstMeaningfulLine
    ? MERMAID_DIAGRAM_START_PATTERN.test(firstMeaningfulLine.trim())
    : false;
}

export function shouldRenderMermaidCodeBlock(language: string, code: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (isMermaidLanguage(normalizedLanguage)) {
    return true;
  }

  // Models often emit Mermaid fenced code blocks without a language label.
  // Apply narrow first-line detection only to plain text or empty languages to avoid rendering explicit ts/js/sh code as diagrams.
  return MERMAID_AUTODETECT_LANGUAGES.has(normalizedLanguage) && isLikelyMermaidCode(code);
}
