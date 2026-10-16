import type { OAuthProviderId } from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, BUILTIN_MODEL_PROVIDER_IDS, ZAI_PROVIDER_ID } from "@zcode/shared";
import { LogInIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import bigModelIcon from "@/assets/provider-icons/logo-bigmodel.svg";
import zaiIcon from "@/assets/provider-icons/logo-zai.svg";
import anthropicIcon from "@/assets/provider-icons/model-provider-anthropic.png";
import deepSeekIcon from "@/assets/provider-icons/model-provider-deepseek.png";
import miniMaxIcon from "@/assets/provider-icons/model-provider-minimax.png";
import moonshotKimiIcon from "@/assets/provider-icons/model-provider-moonshot-kimi.png";
import openAiIcon from "@/assets/provider-icons/model-provider-openai.png";
import xAiIcon from "@/assets/provider-icons/model-provider-xai.png";
import openrouterIcon from "@/assets/provider-icons/model-provider-openrouter-light.svg";

const OAUTH_PROVIDER_ICON_SRC: Partial<Record<OAuthProviderId, string>> = {
  [BIGMODEL_PROVIDER_ID]: bigModelIcon,
  [ZAI_PROVIDER_ID]: zaiIcon,
};

export function renderOAuthProviderIcon(provider: OAuthProviderId, className?: string) {
  const src = OAUTH_PROVIDER_ICON_SRC[provider];
  if (!src) {
    return <LogInIcon className={cn("shrink-0", className)} />;
  }

  return (
    <img src={src} alt="" aria-hidden="true" className={cn("shrink-0 object-contain", className)} />
  );
}

/**
 * Brand asset for a model providerId, keyed by the ids that appear in model selections
 * ("providerId/modelId"). This is the sidebar-side shortcut for contexts that do not load
 * provider configs; the config-driven authority for settings surfaces stays ProviderLogo's
 * BUILTIN_PROVIDER_LOGO_ASSETS (settings/model-provider-section). Keys must cover the agent
 * provider id ("glm") and the OAuth provider ids. Unknown ids return null so callers can fall
 * back to their generic glyph. Brand marks are single-variant assets here; the two
 * theme-dependent logos (openrouter/opencode) use the light variant.
 */
const PROVIDER_ID_ICON_SRC: Readonly<Record<string, string>> = {
  glm: zaiIcon,
  [ZAI_PROVIDER_ID]: zaiIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: zaiIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: zaiIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: zaiIcon,
  [BIGMODEL_PROVIDER_ID]: bigModelIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: bigModelIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: bigModelIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: bigModelIcon,
  openai: openAiIcon,
  [BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan]: openAiIcon,
  anthropic: anthropicIcon,
  deepseek: deepSeekIcon,
  "moonshot-kimi": moonshotKimiIcon,
  moonshot: moonshotKimiIcon,
  minimax: miniMaxIcon,
  xai: xAiIcon,
  openrouter: openrouterIcon,
};

/** Brand asset URL for a known providerId, or null when the caller should render its fallback glyph. */
export function providerBrandIconSrc(providerId: string | undefined): string | null {
  return (providerId ? PROVIDER_ID_ICON_SRC[providerId] : undefined) ?? null;
}
