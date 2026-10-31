import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_MODEL_PROVIDER_IDS, CHATGPT_OAUTH_PROVIDER_ID } from "@zcode/shared";
import { describe, expect, it } from "vitest";

import { CHATGPT_PLAN_PROVIDER_LOGO } from "@/lib/chatgptPlanProvider.js";
import { providerBrandIconSrc, renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import {
  createPresetProviderNodeKey,
  renderModelProviderNavIcon,
} from "@/settings/model-provider-section/utils.js";

describe("ChatGPT plan provider icon", () => {
  it("shows the plan logo in settings navigation before any account is signed in", () => {
    const icon = renderModelProviderNavIcon({
      key: createPresetProviderNodeKey(BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan),
      type: "preset",
      presetId: BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan,
      label: "ChatGPT Plan",
      logo: CHATGPT_PLAN_PROVIDER_LOGO,
      provider: null,
      displayName: "ChatGPT Plan",
      statusProvider: null,
      statusActive: false,
    });

    expect(isValidElement(icon)).toBe(true);
    const element = icon as ReactElement<{ logo?: unknown }>;
    expect(element.type).toBe(ProviderLogo);
    expect(element.props.logo).toEqual(CHATGPT_PLAN_PROVIDER_LOGO);
  });

  it("uses the OpenAI mark for the chatgpt OAuth provider instead of the log-in glyph", () => {
    const markup = renderToStaticMarkup(
      renderOAuthProviderIcon(CHATGPT_OAUTH_PROVIDER_ID, "size-4"),
    );
    expect(markup).toContain("<img");
    expect(markup).toContain(`src="${providerBrandIconSrc("openai")}"`);
  });
});
