import { MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES } from "@zcode/shared/mcp-apps";

/** Maximum UTF-8 bytes allowed for `ui/message` structuredContent after serialization (same cap as tool results). */
export const PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES = MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES;

export type PluginUiFollowUpPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: "empty_prompt" | "structured_too_large"; bytes?: number };

/**
 * The sent message = the plugin text as-is + structuredContent's JSON (a ```json block), with no added
 * "from a plugin / untrusted" plaintext notice; the source goes only into message metadata
 * (`source.kind = "pluginUi"`). structuredContent that cannot be serialized (circular references etc.)
 * is treated as absent.
 */
export function buildPluginUiFollowUpPrompt(
  prompt: string,
  structuredContent: unknown,
): PluginUiFollowUpPromptResult {
  const text = prompt.trim();
  if (!text) return { ok: false, reason: "empty_prompt" };
  if (structuredContent === undefined) return { ok: true, prompt: text };
  let json: string;
  try {
    json = JSON.stringify(structuredContent, null, 2);
  } catch {
    return { ok: true, prompt: text };
  }
  if (json === undefined) return { ok: true, prompt: text };
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES) {
    return { ok: false, reason: "structured_too_large", bytes };
  }
  return { ok: true, prompt: `${text}\n\n\`\`\`json\n${json}\n\`\`\`` };
}
