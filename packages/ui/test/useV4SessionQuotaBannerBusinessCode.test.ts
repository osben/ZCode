// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { SessionErrorInfo } from "@zcode/shared/zcode-protocol-v4";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";

afterEach(cleanup);

function renderBanner(error: SessionErrorInfo, providerId: string) {
  return renderHook(() =>
    useV4SessionQuotaBanner({
      error,
      errorKey: `${error.code}:${error.message}`,
      modelId: "GLM-5.3",
      phase: "error",
      providerId,
      sessionId: "session-business-code",
    }),
  );
}

// Cold hydration restores a provider failure with the adapter error class as `code`;
// the provider business code survives only in the structured attribution.
const hydratedConcurrencyError: SessionErrorInfo = {
  code: "AiSdkModelAdapterError",
  message: "model concurrency limit exceeded",
  recoverable: false,
  at: 1,
  source: "provider",
  attribution: {
    source: "provider",
    reason: "rate_limited",
    providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    statusCode: 429,
    providerErrorCode: "3009",
    retryable: false,
  },
};

describe("useV4SessionQuotaBanner business code source", () => {
  it("takes over a hydrated Start Plan concurrency error from its attributed provider code", () => {
    const { result } = renderBanner(
      hydratedConcurrencyError,
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    );

    expect(result.current.takesOverError).toBe(true);
    expect(result.current.state).toMatchObject({
      kind: "concurrent-limit",
      concurrentLimitBusinessCode: "3009",
    });
  });

  it("takes over a hydrated GLM plan limit from its attributed provider code", () => {
    const { result } = renderBanner(
      {
        ...hydratedConcurrencyError,
        message: "Weekly usage limit reached",
        attribution: { source: "provider", providerErrorCode: "1310" },
      },
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    );

    expect(result.current.takesOverError).toBe(true);
    expect(result.current.state).toMatchObject({
      kind: "provider-limited",
      providerLimitedBusinessCode: "1310",
    });
  });

  it("leaves a non-Start Plan concurrency error to the ordinary error banner", () => {
    const { result } = renderBanner(hydratedConcurrencyError, "custom-anthropic");

    expect(result.current.takesOverError).toBe(false);
  });

  // specs/chatgpt-plan-signin.md "Limits and recovery in Desktop" (L1, L4).
  it("takes over a ChatGPT plan usage limit, live or hydrated", () => {
    const chatGptProvider = "account:chatgpt-plan:a1b2c3d4e5f60718";
    for (const code of ["subscription_sharing_usage_limit_exceeded", "AiSdkModelAdapterError"]) {
      const { result } = renderBanner(
        {
          ...hydratedConcurrencyError,
          code,
          message: "ChatGPT plan usage limit reached.",
          attribution: {
            source: "provider",
            providerId: chatGptProvider,
            providerErrorCode: "subscription_sharing_usage_limit_exceeded",
          },
        },
        chatGptProvider,
      );
      expect(result.current.takesOverError).toBe(true);
      expect(result.current.state).toMatchObject({
        kind: "chatgpt-plan-limited",
        providerLimitedResetAt: null,
      });
      cleanup();
    }
  });

  it("leaves the ChatGPT usage-limit code on another provider to the error banner", () => {
    const { result } = renderBanner(
      {
        ...hydratedConcurrencyError,
        attribution: {
          source: "provider",
          providerErrorCode: "subscription_sharing_usage_limit_exceeded",
        },
      },
      "openai",
    );
    expect(result.current.takesOverError).toBe(false);
  });
});
