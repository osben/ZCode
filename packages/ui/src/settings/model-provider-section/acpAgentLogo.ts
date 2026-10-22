/**
 * Brand marks for ACP agents in Model Settings (nav rows, detail header, catalog rows). Keyed by agent id.
 * Codex runs on OpenAI models and uses the OpenAI mark; Claude Code uses the Anthropic mark. Agents
 * without an entry (qwen, gemini) keep the letter mark. The Cursor mark is a hand-drawn cube approximation,
 * not the vendor's artwork.
 */
import type { ResolvedTheme } from "@/useTheme.js";
import anthropicLogo from "@/assets/provider-icons/model-provider-anthropic.png";
import openAiLogo from "@/assets/provider-icons/model-provider-openai.png";
import cursorDark from "@/assets/provider-icons/acp-agent-cursor-dark.svg";
import cursorLight from "@/assets/provider-icons/acp-agent-cursor-light.svg";
import opencodeDark from "@/assets/provider-icons/model-provider-opencode-dark.svg";
import opencodeLight from "@/assets/provider-icons/model-provider-opencode-light.svg";

interface AcpAgentLogoAsset {
  readonly light: string;
  readonly dark?: string;
}

const ACP_AGENT_LOGO_ASSETS: Readonly<Record<string, AcpAgentLogoAsset>> = {
  opencode: { light: opencodeLight, dark: opencodeDark },
  cursor: { light: cursorLight, dark: cursorDark },
  codex: { light: openAiLogo },
  claude: { light: anthropicLogo },
};

/** The bundled mark for an ACP agent in the given theme, or null when the agent has none. */
export function resolveAcpAgentLogoAsset(agentId: string, theme: ResolvedTheme): string | null {
  const asset = ACP_AGENT_LOGO_ASSETS[agentId];
  if (!asset) return null;
  return theme === "dark" ? (asset.dark ?? asset.light) : asset.light;
}
