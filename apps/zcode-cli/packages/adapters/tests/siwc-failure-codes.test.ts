import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";

function businessError(code: string, status: number): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: code,
    providerId: "account:chatgpt-plan",
    providerKind: "openai",
    providerMessage: `upstream ${code}`,
    responseStatus: status,
    statusCode: status,
  });
}

describe("SIWC subscription_sharing error mapping", () => {
  it("treats the plan usage limit as terminal with the manage-usage message", () => {
    const failure = classifyModelFailure(
      businessError("subscription_sharing_usage_limit_exceeded", 429),
    );
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe(ModelErrorCode.ModelRateLimited);
    expect(failure.reason).toBe(ModelFailureReason.RateLimited);
    expect(failure.message).toContain("https://chatgpt.com/settings/usage");
  });

  it("never retries ineligibility or unsupported capabilities", () => {
    expect(
      classifyModelFailure(businessError("subscription_sharing_user_not_eligible", 403)).retryable,
    ).toBe(false);
    expect(
      classifyModelFailure(businessError("subscription_sharing_unsupported_capability", 400))
        .retryable,
    ).toBe(false);
    expect(
      classifyModelFailure(businessError("subscription_sharing_route_not_supported", 403))
        .retryable,
    ).toBe(false);
  });

  it("classifies an invalid subscriber context as an auth failure", () => {
    const failure = classifyModelFailure(businessError("subscription_sharing_invalid_user", 401));
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe(ModelErrorCode.ProviderNotConfigured);
    expect(failure.reason).toBe(ModelFailureReason.AuthFailed);
  });

  it("keeps credentials and retries transient unavailability with backoff", () => {
    for (const code of [
      "subscription_sharing_usage_unavailable",
      "subscription_sharing_user_unavailable",
    ]) {
      const failure = classifyModelFailure(businessError(code, 503));
      expect(failure.retryable, code).toBe(true);
      expect(failure.code).toBe(ModelErrorCode.ModelRequestFailed);
      expect(failure.reason).toBe(ModelFailureReason.ServerError);
    }
  });

  it("treats chatpass_v2 scope failures as terminal auth errors", () => {
    for (const code of [
      "chatpass_v2_scope_not_authorized",
      "chatpass_v2_invalid_authorization_context",
    ]) {
      const failure = classifyModelFailure(businessError(code, 403));
      expect(failure.retryable, code).toBe(false);
      expect(failure.reason, code).toBe(ModelFailureReason.AuthFailed);
    }
  });
});
