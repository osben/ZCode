/**
 * Brand marks for ACP agents in Model Settings (nav rows, detail header, catalog rows). Keyed by agent id.
 * Codex runs on OpenAI models and uses the OpenAI mark. Cursor, Qwen, Gemini and Claude use the Simple Icons
 * marks recorded in model-provider-logo-sources.json. Agents without an entry keep the letter mark.
 */
import type { ResolvedTheme } from "@/useTheme.js";
import claudeDark from "@/assets/provider-icons/acp-agent-claude-dark.svg";
import claudeLight from "@/assets/provider-icons/acp-agent-claude-light.svg";
import openAiLogo from "@/assets/provider-icons/model-provider-openai.png";
import cursorDark from "@/assets/provider-icons/acp-agent-cursor-dark.svg";
import cursorLight from "@/assets/provider-icons/acp-agent-cursor-light.svg";
import geminiDark from "@/assets/provider-icons/acp-agent-gemini-dark.svg";
import geminiLight from "@/assets/provider-icons/acp-agent-gemini-light.svg";
import qwenDark from "@/assets/provider-icons/acp-agent-qwen-dark.svg";
import qwenLight from "@/assets/provider-icons/acp-agent-qwen-light.svg";
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
  claude: { light: claudeLight, dark: claudeDark },
  qwen: { light: qwenLight, dark: qwenDark },
  gemini: { light: geminiLight, dark: geminiDark },
};

/** The bundled mark for an ACP agent in the given theme, or null when the agent has none. */
export function resolveAcpAgentLogoAsset(agentId: string, theme: ResolvedTheme): string | null {
  const asset = ACP_AGENT_LOGO_ASSETS[agentId];
  if (!asset) return null;
  return theme === "dark" ? (asset.dark ?? asset.light) : asset.light;
}
