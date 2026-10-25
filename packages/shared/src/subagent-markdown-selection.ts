import { decodeCustomModelValue, encodeCustomModelValue } from "./custom-model-value.js";
import {
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
} from "./legacy-model-provider-identity.js";
import { parseModelPickerValue, type ModelSelection } from "./model-selection.js";

const INHERIT_NAMES = new Set(["inherit", "main", "sonnet", "opus", "haiku"]);

/** The canonical Markdown fields are always string model + thoughtLevel; do not interpret intermediate fields. */
export function parseSubagentMarkdownSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  if (typeof frontmatter.model !== "string") return undefined;
  const value = frontmatter.model.trim();
  if (!value || INHERIT_NAMES.has(value)) return undefined;
  let selection: ModelSelection;
  const custom = decodeCustomModelValue(value);
  if (custom) {
    if (!custom.providerId.trim() || !custom.modelName?.trim()) return undefined;
    selection = { providerId: custom.providerId.trim(), modelId: custom.modelName.trim() };
  } else {
    try {
      selection = parseModelPickerValue(value);
    } catch {
      return undefined;
    }
  }
  const reasoningLevel =
    typeof frontmatter.thoughtLevel === "string" ? frontmatter.thoughtLevel.trim() : "";
  return reasoningLevel ? { ...selection, options: { reasoningLevel } } : selection;
}

/** Keep ordinary IDs readable; delimiters or the custom: prefix conflict with the parsing format and must be preserved losslessly with the existing encoding. */
export function formatSubagentMarkdownModel(selection: ModelSelection): string {
  return selection.providerId.startsWith("custom:") ||
    selection.providerId.includes("/") ||
    selection.modelId.includes("$")
    ? encodeCustomModelValue(selection.providerId, selection.modelId)
    : `${selection.providerId}/${selection.modelId}`;
}

function migrateModelValue(value: string): string {
  if (value.startsWith("custom:")) {
    const decoded = decodeCustomModelValue(value);
    if (!decoded?.modelName || !decoded.providerId.startsWith("builtin:")) return value;
    const providerId = migrateLegacyModelProviderId(decoded.providerId);
    if (!providerId || providerId === decoded.providerId) return value;
    // Preserve the encoded source for an unchanged model (including %24 and %2F); do not parse the model name as Picker input again.
    const modelId = migrateLegacyOfficialGlmModelId(decoded.providerId, decoded.modelName);
    const body = value.slice("custom:".length);
    const separator = body.startsWith("builtin:")
      ? body.indexOf(":", "builtin:".length)
      : body.indexOf(":");
    return separator < 0
      ? value
      : `custom:${encodeURIComponent(providerId)}:${modelId === decoded.modelName ? body.slice(separator + 1) : encodeURIComponent(modelId)}`;
  }
  const separator = value.indexOf("/");
  if (separator < 1) return value;
  const oldProvider = value.slice(0, separator);
  if (!oldProvider.startsWith("builtin:")) return value;
  const providerId = migrateLegacyModelProviderId(oldProvider);
  const modelId = value.slice(separator + 1);
  // In the legacy Picker, $ is followed by a tier, not a model; split only ordinary encodings because $ remains part of custom model names.
  const reasoningIndex = modelId.indexOf("$");
  const name = reasoningIndex < 0 ? modelId : modelId.slice(0, reasoningIndex);
  const suffix = reasoningIndex < 0 ? "" : modelId.slice(reasoningIndex);
  return providerId
    ? providerId + "/" + migrateLegacyOfficialGlmModelId(oldProvider, name) + suffix
    : value;
}

/** Replace only the Provider value on the frontmatter model line; do not rebuild YAML, the body, or unrelated formatting. */
export function migrateSubagentMarkdownProvider(content: string): string {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(
    content,
  );
  if (!frontmatter) return content;
  const body = frontmatter[1]!;
  const migrated = body.replace(
    /^(model[ \t]*:[ \t]*)([^\r\n]*)/gmu,
    (line, prefix: string, raw: string) => {
      const scalar = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^#]*?)([ \t]+#.*|[ \t]*)$/u.exec(raw);
      if (!scalar) return line;
      const token = scalar[1]!;
      let value: string;
      try {
        value = token.startsWith('"')
          ? (JSON.parse(token) as string)
          : token.startsWith("'")
            ? token.slice(1, -1).replace(/''/gu, "'")
            : token;
      } catch {
        return line;
      }
      const next = migrateModelValue(value);
      if (next === value) return line;
      const encoded = token.startsWith('"')
        ? JSON.stringify(next)
        : token.startsWith("'")
          ? `'${next.replace(/'/gu, "''")}'`
          : next;
      return prefix + encoded + scalar[2];
    },
  );
  const offset = frontmatter[0].indexOf("\n") + 1;
  return content.slice(0, offset) + migrated + content.slice(offset + body.length);
}
